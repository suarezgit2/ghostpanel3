#!/bin/bash
# ============================================================
# Build curl-impersonate shared library (.so) from static archive (.a)
#
# curl-impersonate v1.4.0+ only ships static .a archives.
# The impers Node.js FFI library requires a shared .so file.
#
# This script:
# 1. Downloads the static .a archive from GitHub releases
# 2. Extracts the object file
# 3. Patches HIDDEN symbol visibility to DEFAULT (using Python)
# 4. Links into a shared .so with all curl_* symbols exported
#
# Usage: ./build-curl-impersonate.sh <version> <output_dir>
# Example: ./build-curl-impersonate.sh v1.5.1 /opt/curl-impersonate
# ============================================================

set -euo pipefail

VERSION="${1:-v1.5.1}"
OUTPUT_DIR="${2:-/opt/curl-impersonate}"
SCRIPT_DIR="${SCRIPT_DIR:-$(cd "$(dirname "$0")" && pwd)}"
WORK_DIR="$(mktemp -d)"

echo "[curl-impersonate] Building shared library from ${VERSION} static archive..."

# Download
ARCHIVE_URL="https://github.com/lexiforest/curl-impersonate/releases/download/${VERSION}/libcurl-impersonate-${VERSION}.x86_64-linux-gnu.tar.gz"
echo "[curl-impersonate] Downloading ${ARCHIVE_URL}..."
wget -q "${ARCHIVE_URL}" -O "${WORK_DIR}/archive.tar.gz"

# Extract
echo "[curl-impersonate] Extracting..."
tar xzf "${WORK_DIR}/archive.tar.gz" -C "${WORK_DIR}/"

# Verify we got the .a file
if [ ! -f "${WORK_DIR}/libcurl-impersonate.a" ]; then
    echo "[curl-impersonate] ERROR: libcurl-impersonate.a not found in archive"
    ls -la "${WORK_DIR}/"
    exit 1
fi

# Extract object files from the .a archive
echo "[curl-impersonate] Extracting object files from static archive..."
cd "${WORK_DIR}"
ar x libcurl-impersonate.a

# Find the main object file (usually libcurl-impersonate.full.o or similar)
OBJ_FILE=$(ls *.o 2>/dev/null | head -1)
if [ -z "${OBJ_FILE}" ]; then
    echo "[curl-impersonate] ERROR: No .o files found in archive"
    exit 1
fi
echo "[curl-impersonate] Found object file: ${OBJ_FILE}"

# Patch HIDDEN visibility to DEFAULT
echo "[curl-impersonate] Patching ELF symbol visibility..."
python3 "${SCRIPT_DIR}/patch-elf-visibility.py" "${OBJ_FILE}" "${OBJ_FILE}.patched"
mv "${OBJ_FILE}.patched" "${OBJ_FILE}"

# Link into shared library
echo "[curl-impersonate] Linking shared library..."
gcc -shared -o libcurl-impersonate.so "${OBJ_FILE}" -lpthread -ldl -lm -lrt

# Verify symbols are exported
CURL_SYMBOLS=$(nm -D libcurl-impersonate.so 2>/dev/null | grep -c "T curl_" || true)
echo "[curl-impersonate] Exported curl_* symbols: ${CURL_SYMBOLS}"

if [ "${CURL_SYMBOLS}" -lt 50 ]; then
    echo "[curl-impersonate] WARNING: Expected 90+ curl symbols, got ${CURL_SYMBOLS}"
    echo "[curl-impersonate] Checking symbol visibility..."
    nm -D libcurl-impersonate.so | grep "curl_easy" | head -5
fi

# Install
mkdir -p "${OUTPUT_DIR}"
cp libcurl-impersonate.so "${OUTPUT_DIR}/"

# Create compatibility symlinks (impers may look for these names)
cd "${OUTPUT_DIR}"
ln -sf libcurl-impersonate.so libcurl-impersonate-chrome.so

echo "[curl-impersonate] ✓ Installed to ${OUTPUT_DIR}/libcurl-impersonate.so (${CURL_SYMBOLS} symbols)"

# Cleanup
rm -rf "${WORK_DIR}"
