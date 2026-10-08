#!/bin/sh
set -eu
cd "$(dirname "$0")"
mkdir -p bin
swiftc -module-cache-path "${TMPDIR:-/tmp}/parcel-gmail-module-cache" -parse-as-library -O Sources/Importer.swift -o bin/parcel-gmail-importer-next
if [ "$(uname -s)" = Darwin ]; then
  /usr/bin/codesign --force --sign - --identifier local.parcel-gmail-importer bin/parcel-gmail-importer-next
fi
bin/parcel-gmail-importer-next self-test
