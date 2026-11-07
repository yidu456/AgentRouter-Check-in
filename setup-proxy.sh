#!/bin/bash
# Linux Actions entrypoint; parsing and Xray lifecycle are shared with isolated mode.
set -euo pipefail
python "$(dirname "$0")/legacy_proxy.py"
