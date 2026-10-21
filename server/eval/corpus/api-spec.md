# Platform API Specification

## Authentication

Access tokens expire after 15 minutes. Refresh tokens are valid for 30 days and
rotate on every use: issuing a new refresh token invalidates the previous one.
Requests authenticate with the Bearer scheme, for example
`Authorization: Bearer <access_token>`. A request with an expired access token
returns HTTP 401 and must be retried after refreshing.

## Rate limits

The public API allows 600 requests per minute per API key. Exceeding the limit
returns HTTP 429 together with a `Retry-After` header that indicates how many
seconds the client should wait before retrying.

## Endpoints

`GET /v1/orders` returns a paginated list of orders. Pagination uses the `cursor`
and `limit` query parameters. The maximum page size is 200 items.

## Errors

All error responses use the shape `{ "error": { "code", "message" } }`. Codes are
stable strings such as `bad_request`, `not_found` and `rate_limited`.
