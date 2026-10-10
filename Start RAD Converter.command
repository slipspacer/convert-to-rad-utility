#!/bin/bash
# Double-click in Finder to start the RAD Converter and open it in your browser.
# Keep the Terminal window open while you use it; close it (or press Ctrl+C) to stop.

cd "$(dirname "$0")" || exit 1

pause_and_exit() {
  echo
  read -n 1 -s -r -p "Press any key to close this window."
  exit 1
}

# macOS ships a python3 stub that only offers to install the Command Line Tools,
# so check that it actually runs.
if ! python3 -c "" >/dev/null 2>&1; then
  echo "Python 3 is needed to serve the converter locally."
  echo "If macOS offered to install the Command Line Tools, accept, then double-click this file again."
  echo "Otherwise install Python 3 from https://www.python.org/downloads/"
  pause_and_exit
fi

# Use 8090, or the next free port if something else is already on it.
PORT=8090
while lsof -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; do
  PORT=$((PORT + 1))
done
URL="http://localhost:$PORT"

echo "RAD Converter running at $URL"
echo "Leave this window open while you use it. Close it or press Ctrl+C to stop."
echo

# Choosing a save folder needs a Chromium browser, so prefer Chrome or Edge.
(
  sleep 1
  open -a "Google Chrome" "$URL" 2>/dev/null ||
    open -a "Microsoft Edge" "$URL" 2>/dev/null ||
    open "$URL"
) &

python3 serve.py --port "$PORT" || pause_and_exit
