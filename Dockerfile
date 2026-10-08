FROM swift:6.4.0-noble AS build
WORKDIR /build
COPY Sources/ Sources/
COPY build.sh ./build.sh
RUN sh build.sh

FROM swift:6.4.0-noble AS runtime
RUN groupadd --gid 10001 importer && useradd --uid 10001 --gid 10001 --no-create-home importer \
    && mkdir -p /app/bin /state && chown 10001:10001 /state && chmod 0700 /state
COPY --from=build /build/bin/parcel-gmail-importer-next /app/bin/parcel-gmail-importer
ENV PARCEL_STATE_DIR=/state
USER 10001:10001
WORKDIR /app
ENTRYPOINT ["/app/bin/parcel-gmail-importer"]
CMD ["self-test"]
