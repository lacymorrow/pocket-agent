# API Versioning Strategy

Pocket-Agent follows **URI-based, semantic versioning** for its HTTP endpoints.

```
/v{major}.{minor}/{resource}
```

* **Major** – breaking changes (e.g. 1.x → 2.0).  
* **Minor** – additive, backwards-compatible changes.  
* Patch versions are **not** surfaced in the URI – clients should rely on response headers for the exact server build.

Example:
* `POST /v1.0/chat-update` – current stable endpoint.  
* `GET  /v2.0/chat-update` – future breaking change.

### Deprecation Policy
* A version is considered **stable** for at least **12 months** after release.  
* Deprecated versions return header `Deprecation: version="<date>"` and a `Link` header pointing to migration docs.  
* End-of-life versions return **410 Gone**.

### Version Negotiation
Clients **must** specify the desired version in the URL. If omitted, the server responds with `400 Bad Request` and an error body describing available versions.