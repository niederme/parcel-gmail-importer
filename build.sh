#!/bin/sh
set -eu
cd "$(dirname "$0")"
mkdir -p bin
xcrun swiftc -module-cache-path /tmp/parcel-gmail-module-cache -parse-as-library -O Sources/Importer.swift -o bin/parcel-gmail-importer-next
/usr/bin/codesign --force --sign - --identifier local.parcel-gmail-importer bin/parcel-gmail-importer-next
bin/parcel-gmail-importer-next self-test
