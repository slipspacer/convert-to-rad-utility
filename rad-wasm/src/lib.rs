//! Browser-side RAD converter.
//!
//! Wraps the same pipeline as Spark's `build-lod` CLI (rust/build-lod in
//! sparkjsdev/spark) so it can run inside a Web Worker:
//!
//!   decode (ply / compressed ply / spz / splat / ksplat / sog / rad)
//!   -> drop invalid splats, clamp SH, crop
//!   -> build LoD tree (bhatt-lod "quality" or tiny-lod "quick")
//!   -> chunk tree ordering -> RAD encode (single file or header + .radc chunks)

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use spark_lib::{
    bhatt_lod, chunk_tree,
    csplat::CsplatArray,
    decoder::{ChunkReceiver, MultiDecoder, SplatGetter, SplatReceiver},
    gsplat::GsplatArray,
    rad::{
        RadAlphaEncoding, RadCenterEncoding, RadEncoder, RadOrientationEncoding, RadRgbEncoding,
        RadScalesEncoding, RadShEncoding,
    },
    tiny_lod,
    tsplat::{Tsplat, TsplatArray, TsplatMut},
};
use wasm_bindgen::prelude::*;

#[wasm_bindgen(start)]
pub fn start() {
    console_error_panic_hook::set_once();
}

#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
enum LodMethod {
    #[default]
    Quality,
    Quick,
    None,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct ProcessOptions {
    lod: LodMethod,
    /// Overrides the default LoD base (1.75 for quality, 1.5 for quick)
    lod_base: Option<f32>,
    max_sh: Option<usize>,
    min_box: Option<[f32; 3]>,
    max_box: Option<[f32; 3]>,
    /// [x, y, z, radius]
    within_dist: Option<[f32; 4]>,
    inflate: bool,
}

impl Default for ProcessOptions {
    fn default() -> Self {
        Self {
            lod: LodMethod::Quality,
            lod_base: None,
            max_sh: None,
            min_box: None,
            max_box: None,
            within_dist: None,
            inflate: false,
        }
    }
}

#[derive(Debug, Default, Deserialize, Serialize)]
#[serde(default)]
struct EncodeOptions {
    center: RadCenterEncoding,
    alpha: RadAlphaEncoding,
    rgb: RadRgbEncoding,
    scales: RadScalesEncoding,
    orientation: RadOrientationEncoding,
    sh: RadShEncoding,
    #[serde(rename = "chunkPrefix")]
    chunk_prefix: Option<String>,
}

fn js_err(err: impl std::fmt::Display) -> JsError {
    JsError::new(&err.to_string())
}

fn to_js<T: Serialize>(value: &T) -> Result<JsValue, JsError> {
    value
        .serialize(&serde_wasm_bindgen::Serializer::json_compatible())
        .map_err(js_err)
}

/// 2nd..98th percentile of splat centers per axis, so stray floaters don't
/// throw off camera framing in the preview.
fn robust_bounds<TA: TsplatArray>(splats: &TA) -> Value {
    let n = splats.len();
    let mut axes: [Vec<f32>; 3] = std::array::from_fn(|_| Vec::with_capacity(n));
    for i in 0..n {
        let c = splats.get(i).center();
        axes[0].push(c.x);
        axes[1].push(c.y);
        axes[2].push(c.z);
    }
    let lo = ((n as f32) * 0.02) as usize;
    let hi = (((n as f32) * 0.98) as usize).min(n - 1);
    let mut min = [0.0f32; 3];
    let mut max = [0.0f32; 3];
    for d in 0..3 {
        let v = &mut axes[d];
        min[d] = *v.select_nth_unstable_by(lo, f32::total_cmp).1;
        max[d] = *v.select_nth_unstable_by(hi, f32::total_cmp).1;
    }
    json!({ "min": min, "max": max })
}

trait SplatArray:SplatReceiver + SplatGetter + TsplatArray + 'static {}
impl<T: SplatReceiver + SplatGetter + TsplatArray + 'static> SplatArray for T {}

struct Pipeline<TS: SplatArray> {
    decoder: Option<MultiDecoder<TS>>,
    splats: Option<TS>,
    file_type: String,
    description: Map<String, Value>,
}

impl<TS: SplatArray> Pipeline<TS> {
    fn new(splats: TS, file_name: &str, file_type: Option<&str>) -> Result<Self, JsError> {
        let file_type = match file_type {
            Some(ft) => Some(spark_lib::decoder::SplatFileType::from_enum_str(ft).map_err(js_err)?),
            None => None,
        };
        Ok(Self {
            decoder: Some(MultiDecoder::new(splats, file_type, Some(file_name))),
            splats: None,
            file_type: String::new(),
            description: Map::new(),
        })
    }

    fn push(&mut self, bytes: &[u8]) -> Result<(), JsError> {
        let decoder = self.decoder.as_mut().ok_or_else(|| js_err("Decoding already finished"))?;
        decoder.push(bytes).map_err(js_err)
    }

    fn finish(&mut self) -> Result<Value, JsError> {
        let mut decoder = self.decoder.take().ok_or_else(|| js_err("Decoding already finished"))?;
        decoder.finish().map_err(js_err)?;
        self.file_type = decoder
            .file_type
            .map(|ft| ft.to_enum_str().to_string())
            .unwrap_or_else(|| "unknown".to_string());
        let splats = decoder.into_splats();
        let info = json!({
            "fileType": self.file_type,
            "splatCount": splats.len(),
            "shDegree": TsplatArray::max_sh_degree(&splats),
            "hasLod": splats.has_lod_tree(),
        });
        self.description.insert("input_file_type".into(), json!(self.file_type));
        self.description.insert("input_splat_count".into(), json!(splats.len()));
        self.description.insert("input_sh_degree".into(), json!(TsplatArray::max_sh_degree(&splats)));
        self.splats = Some(splats);
        Ok(info)
    }

    fn process(&mut self, options: &ProcessOptions, log: &dyn Fn(&str)) -> Result<Value, JsError> {
        let splats = self.splats.as_mut().ok_or_else(|| js_err("No decoded splats"))?;
        let desc = &mut self.description;

        let before = splats.len();
        splats.retain(|splat| {
            splat.center().is_finite()
                && splat.scales().is_finite()
                && splat.quaternion().is_finite()
                && splat.opacity().is_finite()
                && splat.rgb().is_finite()
        });
        let non_finite = before - splats.len();
        if non_finite > 0 {
            log(&format!("Removed {} splats with non-finite values", non_finite));
            desc.insert("non_finite_splat_count".into(), json!(non_finite));
        }

        let before = splats.len();
        splats.retain(|splat| {
            splat.opacity() > 0.0
                && splat.max_scale() > 0.0
                && splat.quaternion().length() > 0.0
        });
        let empty = before - splats.len();
        if empty > 0 {
            log(&format!("Removed {} empty splats (zero opacity / scale / rotation)", empty));
            desc.insert("empty_splat_count".into(), json!(empty));
        }

        if let Some(max_sh) = options.max_sh {
            let max_sh = max_sh.min(3);
            splats.clamp_sh_degree(max_sh);
            desc.insert("clamp_sh_degree".into(), json!(max_sh));
        }

        if let Some(min_box) = options.min_box {
            splats.retain(|s| {
                let c = s.center();
                c.x >= min_box[0] && c.y >= min_box[1] && c.z >= min_box[2]
            });
            desc.insert("min_box".into(), json!(min_box));
        }
        if let Some(max_box) = options.max_box {
            splats.retain(|s| {
                let c = s.center();
                c.x <= max_box[0] && c.y <= max_box[1] && c.z <= max_box[2]
            });
            desc.insert("max_box".into(), json!(max_box));
        }
        if let Some([x, y, z, r]) = options.within_dist {
            splats.retain(|s| {
                let c = s.center();
                (c.x - x).powi(2) + (c.y - y).powi(2) + (c.z - z).powi(2) <= r * r
            });
            desc.insert("within_dist".into(), json!([x, y, z]));
            desc.insert("within_dist_radius".into(), json!(r));
        }

        if splats.len() == 0 {
            return Err(js_err("No splats left to encode after filtering/cropping"));
        }
        let bounds = robust_bounds(splats);

        let had_lod = splats.has_lod_tree();
        let mut lod_info = "none";
        if options.lod != LodMethod::None {
            if had_lod {
                // Input already has an LoD tree (e.g. a .rad): strip interior
                // nodes back to the original leaf splats and rebuild.
                let before = splats.len();
                splats.retain_children(|_, children| children.is_empty());
                splats.clear_children();
                log(&format!("Stripped {} existing LoD interior splats", before - splats.len()));
                desc.insert("unlod".into(), json!(true));
            }
            let leaf_count = splats.len();
            match options.lod {
                LodMethod::Quality => {
                    let base = options.lod_base.unwrap_or(1.75).clamp(1.1, 16.0);
                    log(&format!("Building LoD tree: bhatt-lod (quality), base {}", base));
                    bhatt_lod::compute_lod_tree(splats, base, log);
                    desc.insert("method".into(), json!(format!("BhattLod {{ lod_base: {} }}", base)));
                    lod_info = "quality";
                }
                LodMethod::Quick => {
                    let base = options.lod_base.unwrap_or(1.5).clamp(1.1, 16.0);
                    log(&format!("Building LoD tree: tiny-lod (quick), base {}", base));
                    tiny_lod::compute_lod_tree(splats, base, false, log);
                    desc.insert("method".into(), json!(format!("TinyLod {{ lod_base: {} }}", base)));
                    lod_info = "quick";
                }
                LodMethod::None => unreachable!(),
            }
            log(&format!("LoD tree: {} leaf splats -> {} total splats", leaf_count, splats.len()));
        } else if had_lod {
            lod_info = "kept";
        }

        if splats.has_lod_tree() {
            if lod_info != "kept" {
                log("Ordering LoD tree into chunks");
                chunk_tree::chunk_tree(splats, 0, log);
            }
            splats.encode_lod_opacity();
        }

        if options.inflate {
            for i in 0..splats.len() {
                let mut splat = splats.get_mut(i);
                if splat.opacity() > 1.0 {
                    let d = splat.opacity() * 4.0 - 3.0;
                    let opacity = ((d * d - 1.0) / std::f32::consts::E).exp();
                    let rescale = opacity.powf(1.0 / 3.0);
                    let scales = splat.scales() * rescale;
                    splat.set_scales(scales);
                    splat.set_opacity(1.0);
                }
            }
            desc.insert("inflate_scale".into(), json!(true));
        }

        let sh_degree = TsplatArray::max_sh_degree(splats);
        desc.insert("final_splat_count".into(), json!(splats.len()));
        desc.insert("max_sh_degree".into(), json!(sh_degree));

        Ok(json!({
            "splatCount": splats.len(),
            "shDegree": sh_degree,
            "hasLod": splats.has_lod_tree(),
            "lod": lod_info,
            "bounds": bounds,
        }))
    }

    fn encode(&mut self, options: &EncodeOptions, log: &dyn Fn(&str)) -> Result<(Vec<Vec<u8>>, Vec<String>, Value), JsError> {
        let splats = self.splats.take().ok_or_else(|| js_err("No processed splats to encode"))?;
        let mut encoder = RadEncoder::new(splats)
            .with_center_encoding(options.center)
            .with_alpha_encoding(options.alpha)
            .with_rgb_encoding(options.rgb)
            .with_scales_encoding(options.scales)
            .with_orientation_encoding(options.orientation)
            .with_sh_encoding(options.sh);
        self.description.insert(
            "input_encoding".into(),
            json!({
                "center": encoder.center_encoding, "alpha": encoder.alpha_encoding,
                "rgb": encoder.rgb_encoding, "scales": encoder.scales_encoding,
                "orientation": encoder.orientation_encoding, "sh": encoder.sh_encoding,
            }),
        );

        log("Resolving property encodings");
        encoder.resolve_encoding();
        let resolved = json!({
            "center": encoder.center_encoding, "alpha": encoder.alpha_encoding,
            "rgb": encoder.rgb_encoding, "scales": encoder.scales_encoding,
            "orientation": encoder.orientation_encoding, "sh": encoder.sh_encoding,
            "encoding": encoder.encoding,
        });
        self.description.insert("resolved_encoding".into(), resolved.clone());
        self.description.insert("converter".into(), json!("rad-converter (web, spark-lib)"));

        let comment = serde_json::to_string_pretty(&self.description).map_err(js_err)?;
        let mut encoder = encoder.with_comment(comment);

        log("Encoding RAD chunks");
        let mut header = Vec::new();
        let (files, names) = match options.chunk_prefix.as_deref() {
            Some(prefix) if !prefix.is_empty() => {
                let chunks = encoder.encode_with_chunks(&mut header, prefix).map_err(js_err)?;
                let mut files = vec![header];
                let mut names = vec![String::new()];
                for (name, bytes) in chunks {
                    names.push(name);
                    files.push(bytes);
                }
                (files, names)
            }
            _ => {
                encoder.encode(&mut header).map_err(js_err)?;
                (vec![header], vec![String::new()])
            }
        };
        Ok((files, names, resolved))
    }
}

enum Inner {
    G(Pipeline<GsplatArray>),
    C(Pipeline<CsplatArray>),
}

macro_rules! dispatch {
    ($self:ident, $p:ident => $e:expr) => {
        match &mut $self.inner {
            Inner::G($p) => $e,
            Inner::C($p) => $e,
        }
    };
}

/// Streaming converter: `push()` file bytes, `finish()`, `process()`, `encode()`.
#[wasm_bindgen]
pub struct RadConverter {
    inner: Inner,
}

#[wasm_bindgen]
impl RadConverter {
    /// `compact`: use Spark's compact csplat representation instead of the
    /// default higher-precision gsplat (lower memory for huge scenes).
    /// `file_type`: optional explicit type ("ply", "spz", "splat", "ksplat",
    /// "pcsogszip", "rad"); auto-detected from bytes/filename otherwise.
    #[wasm_bindgen(constructor)]
    pub fn new(file_name: &str, compact: bool, file_type: Option<String>) -> Result<RadConverter, JsError> {
        let ft = file_type.as_deref();
        let inner = if compact {
            Inner::C(Pipeline::new(CsplatArray::new(), file_name, ft)?)
        } else {
            Inner::G(Pipeline::new(GsplatArray::new(), file_name, ft)?)
        };
        Ok(Self { inner })
    }

    pub fn push(&mut self, bytes: &[u8]) -> Result<(), JsError> {
        dispatch!(self, p => p.push(bytes))
    }

    /// Finish decoding. Returns `{ fileType, splatCount, shDegree, hasLod }`.
    pub fn finish(&mut self) -> Result<JsValue, JsError> {
        let info = dispatch!(self, p => p.finish())?;
        to_js(&info)
    }

    /// Clean, crop and build the LoD tree. `log` receives progress strings.
    pub fn process(&mut self, options: JsValue, log: &js_sys::Function) -> Result<JsValue, JsError> {
        let options: ProcessOptions = if options.is_undefined() || options.is_null() {
            ProcessOptions::default()
        } else {
            serde_wasm_bindgen::from_value(options).map_err(js_err)?
        };
        let logger = |s: &str| {
            let _ = log.call1(&JsValue::NULL, &JsValue::from_str(s));
        };
        let info = dispatch!(self, p => p.process(&options, &logger))?;
        to_js(&info)
    }

    /// Encode to RAD. Returns `{ files: Uint8Array[], names: string[], encoding }`
    /// where `files[0]` is the .rad (header + all chunks, or header only when
    /// `chunkPrefix` is set, in which case `files[1..]` are the .radc chunks).
    pub fn encode(&mut self, options: JsValue, log: &js_sys::Function) -> Result<JsValue, JsError> {
        let options: EncodeOptions = if options.is_undefined() || options.is_null() {
            EncodeOptions::default()
        } else {
            serde_wasm_bindgen::from_value(options).map_err(js_err)?
        };
        let logger = |s: &str| {
            let _ = log.call1(&JsValue::NULL, &JsValue::from_str(s));
        };
        let (files, names, encoding) = dispatch!(self, p => p.encode(&options, &logger))?;

        let out = js_sys::Object::new();
        let arr = js_sys::Array::new();
        for file in files {
            arr.push(&js_sys::Uint8Array::from(file.as_slice()));
        }
        js_sys::Reflect::set(&out, &"files".into(), &arr).map_err(|_| js_err("set files"))?;
        js_sys::Reflect::set(&out, &"names".into(), &to_js(&names)?).map_err(|_| js_err("set names"))?;
        js_sys::Reflect::set(&out, &"encoding".into(), &to_js(&encoding)?).map_err(|_| js_err("set encoding"))?;
        Ok(out.into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Native parity check against Spark's build-lod CLI. Run with:
    /// RAD_TEST_INPUT=scene.spz RAD_TEST_OUTPUT=out.rad RAD_TEST_LOD=quick \
    ///   cargo test --release -- --ignored parity
    #[test]
    #[ignore]
    fn parity() {
        let input = std::env::var("RAD_TEST_INPUT").expect("RAD_TEST_INPUT");
        let output = std::env::var("RAD_TEST_OUTPUT").expect("RAD_TEST_OUTPUT");
        let lod = match std::env::var("RAD_TEST_LOD").as_deref() {
            Ok("quick") => LodMethod::Quick,
            Ok("none") => LodMethod::None,
            _ => LodMethod::Quality,
        };
        let bytes = std::fs::read(&input).unwrap();
        let mut p = Pipeline::new(GsplatArray::new(), &input, None).unwrap_or_else(|_| panic!("new"));
        for chunk in bytes.chunks(1 << 20) {
            p.push(chunk).unwrap_or_else(|_| panic!("push"));
        }
        p.finish().unwrap_or_else(|_| panic!("finish"));
        let options = ProcessOptions { lod, ..Default::default() };
        p.process(&options, &|_| {}).unwrap_or_else(|_| panic!("process"));
        let (files, _, _) = p.encode(&EncodeOptions::default(), &|_| {}).unwrap_or_else(|_| panic!("encode"));
        std::fs::write(&output, &files[0]).unwrap();
    }
}
