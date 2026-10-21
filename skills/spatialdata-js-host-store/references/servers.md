# Server configuration for SpatialData.js stores

Each section gives the minimum that meets the requirements in `SKILL.md`. The
examples allow any origin (`*`). For a private bucket or a single viewer,
replace `*` with that viewer's origin. After applying any of these, run
`scripts/check_hosting.py` against the public URL.

## Amazon S3

The store must be publicly readable, or served through presigned URLs or
CloudFront. Set the bucket CORS configuration:

```json
[
  {
    "AllowedOrigins": ["*"],
    "AllowedMethods": ["GET", "HEAD"],
    "AllowedHeaders": ["Range"],
    "ExposeHeaders": ["Content-Range", "Content-Length", "Accept-Ranges", "ETag"],
    "MaxAgeSeconds": 3600
  }
]
```

To apply it, save the JSON as the value of a top-level `CORSRules` key and run
`aws s3api put-bucket-cors --bucket BUCKET --cors-configuration file://cors.json`.
S3 serves bounded and suffix ranges natively.

Behind CloudFront, forward the `Origin`, `Access-Control-Request-Method` and
`Access-Control-Request-Headers` headers. Otherwise a cached response without
CORS headers is served to browsers. Also leave compression off for these paths.

## Google Cloud Storage

```json
[
  {
    "origin": ["*"],
    "method": ["GET", "HEAD"],
    "responseHeader": ["Content-Range", "Content-Length", "Range", "Accept-Ranges"],
    "maxAgeSeconds": 3600
  }
]
```

Apply it with `gcloud storage buckets update gs://BUCKET --cors-file=cors.json`.
In GCS, `responseHeader` controls both the allowed request headers and the
exposed response headers, so `Range` and `Content-Range` both belong there.

Do not upload with `gsutil cp -z` or `-Z`, or any `Content-Encoding: gzip`. GCS
then decompresses on the fly and ignores `Range` for those objects.

## Cloudflare R2

Use a public bucket or a custom domain. In the bucket's CORS policy, use the
same rules as S3: allowed origins, `GET`/`HEAD`, allowed header `Range`, and
exposed `Content-Range`, `Content-Length` and `ETag`. Do not put the bucket
behind a Cloudflare cache rule that compresses `.parquet` or chunk files.

## nginx

nginx serves bounded and suffix ranges for static files by default.

```nginx
location /stores/ {
    alias /srv/stores/;
    gzip off;
    add_header Access-Control-Allow-Origin * always;
    add_header Access-Control-Expose-Headers "Content-Range, Content-Length, Accept-Ranges, ETag" always;
    add_header Cache-Control no-cache always;
    if ($request_method = OPTIONS) {
        add_header Access-Control-Allow-Origin * always;
        add_header Access-Control-Allow-Methods "GET, HEAD, OPTIONS" always;
        add_header Access-Control-Allow-Headers "Range" always;
        add_header Access-Control-Max-Age 600 always;
        return 204;
    }
}
```

`add_header` inside `if` replaces the outer headers rather than adding to them,
which is why `Access-Control-Allow-Origin` is repeated in the block.

## Caddy

```caddy
example.org {
    root * /srv/stores
    file_server
    header Access-Control-Allow-Origin *
    header Access-Control-Expose-Headers "Content-Range, Content-Length, Accept-Ranges, ETag"
    header Cache-Control no-cache
    @preflight method OPTIONS
    handle @preflight {
        header Access-Control-Allow-Methods "GET, HEAD, OPTIONS"
        header Access-Control-Allow-Headers "Range"
        respond 204
    }
}
```

Do not add an `encode` directive for these paths.

## Hosts that usually do not work

The following often fail, because they ignore or refuse ranges, omit CORS,
compress everything, or redirect to a CDN that drops headers:
- dataset archives that serve files only as downloads, such as many data
  repositories;
- Git hosting "raw" URLs;
- generic file-sharing links.

Run `check_hosting.py` before recommending one. If it fails, copy the store to
object storage instead.
