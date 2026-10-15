# LetsPlayQuiz public API v1

This is the HTTP contract that the [`letsplayquiz` CLI](../packages/cli) uses. You can call it directly from any client. The server owns every quiz rule; clients should treat a `validation_failed` response as the final word.

## Basics

- **Base URL:** `https://letsplayquiz.net` (the CLI default; override with `--api`). All paths below are relative to it.
- **Format:** JSON in, JSON out. Requests with a body must send `Content-Type: application/json` (a `charset` parameter is fine). The body must be valid UTF-8 and at most **64 KiB**.
- **No authentication.** Creating a quiz needs no account. Ownership of a published quiz is proven only by the secret owner URL returned on publish.
- **Language:** every endpoint accepts `?lang=ko|ja|en` (unknown or missing values mean `ko`). It only changes the language of `message` text and the `lang` field in responses; `code`, `path` and HTTP statuses never depend on it.
- **Strict input:** unknown fields anywhere in a quiz (top level or nested) are rejected, so typos are reported instead of silently dropped.

## Endpoints

| Method and path | Purpose |
|---|---|
| `GET /api/v1/guide` | Rules and complete examples, per kind |
| `POST /api/v1/tests/validate` | Check a quiz without saving it |
| `POST /api/v1/tests` | Check and, if it passes, publish a quiz |

### `GET /api/v1/guide`

Read-only; no body.

| Query | Values | Default |
|---|---|---|
| `kind` | `score`, `type`, `balance`, `worldcup`, `level` | all kinds |
| `format` | `markdown`, `json` | `markdown` |
| `lang` | `ko`, `ja`, `en` | `ko` |

- `format=markdown` returns `text/markdown; charset=utf-8`.
- `format=json` returns an object with `lang`, `version` (currently `1`), `workflow`, `exitCodes`, `fields`, `covers`, `kinds` and `blockers`. `covers` lists every value the `cover` field accepts (`key`, `label`, `group`, `groupLabel`). Each entry of `kinds` has `kind`, `label`, `hint`, `rules` (choice counts, result type counts, question counts, weight model) and a full `example` quiz that passes validation. Examples are written in the requested `lang`.
- Responses carry `Cache-Control: public, max-age=300`.
- An unknown `kind` or `format` returns `400` with error code `invalid_value`.

### `POST /api/v1/tests/validate`

Takes the same body as `POST /api/v1/tests` and saves nothing. **A quiz that fails validation still returns HTTP `200`** with `ok: false`; the request itself succeeded. Decide by the `ok` field, not the status.

Passing:

```json
{ "ok": true, "lang": "en", "blockers": [], "warnings": [] }
```

Failing:

```json
{
  "ok": false,
  "lang": "en",
  "error": { "code": "validation_failed", "message": "..." },
  "blockers": [{ "code": "choice_count", "message": "...", "path": ["questions", 0, "choices"] }],
  "warnings": []
}
```

### `POST /api/v1/tests`

Runs the same checks, then publishes. Success is `201`:

```json
{
  "ok": true,
  "lang": "en",
  "slug": "ab12cd34",
  "url": "https://letsplayquiz.net/t/ab12cd34",
  "ownerUrl": "https://letsplayquiz.net/t/ab12cd34/owner/<secret>",
  "listing": "none",
  "warnings": []
}
```

- `url` is the public link to share. `slug` is 8 characters of `[a-z0-9]`.
- `ownerUrl` is the owner (dashboard) link. **It is the only proof of ownership, it is shown exactly once and cannot be reissued.** Do not share it, and do not write it to shared logs (the CLI redacts it in error output for this reason). The token is part of the URL; there is no separate token field.
- `listing` is `"requested"` if the request set `requestListing: true`, otherwise `"none"`. A request does not publish anything to the home listing by itself; it is only a request to be considered.
- `warnings` use the issue shape below and do not block publishing.
- Publishing is **not idempotent**. Sending the same body twice creates two quizzes. After a `502 publish_unknown`, a timeout or a dropped connection the outcome is unknown; confirm before retrying.

## Quiz body

All the quiz-taking kinds share the same top-level shape. Strings are trimmed before the length checks.

| Field | Type | Required | Notes |
|---|---|---|---|
| `kind` | `"score" \| "type" \| "balance" \| "worldcup" \| "level"` | yes | |
| `title` | string | yes | 1 to 60 characters |
| `description` | string | no | up to 200 characters; empty counts as absent |
| `locale` | `"ko" \| "ja" \| "en"` | no | language players see; default `ko` |
| `theme` | `"classic" \| "mono" \| "candy" \| "ocean" \| "lemon" \| "mint" \| "grape"` | no | default `classic` |
| `requestListing` | boolean | no | default `false`; ask to be considered for the home listing. Avoid for quizzes with private content such as friends' names |
| `cover` | string or `null` | no | a cover key from the `covers` list of `GET /api/v1/guide?format=json`; it becomes the quiz's face on the home list card and the start screen. Omit it or send `null` for the default cover of the kind. A key that is not in the list is rejected with `invalid_value`. If the cover cannot be saved the quiz is still published with the default cover and the response's `warnings` include `cover_save_failed` |
| `questions` | array | yes | up to 20 entries; must be `[]` for `worldcup` |
| `resultTypes` | array | yes | see per-kind rules; up to 16 entries (`worldcup`: exactly 8 or 16) |
| `tieRule` | `"order" \| "custom"` | yes | how ties between result types are resolved (see below) |
| `tieResults` | array | yes | up to 66 entries; must be `[]` for `worldcup` |

`questions[]`:

| Field | Type | Notes |
|---|---|---|
| `body` | string | 1 to 120 characters |
| `choices` | array | count depends on kind (below) |
| `choices[].label` | string | 1 to 40 characters |
| `choices[].weights` | object | map from key to integer 0 to 100; meaning depends on kind |

`resultTypes[]`:

| Field | Type | Notes |
|---|---|---|
| `key` | string | matches `^[a-z0-9_]{1,20}$`; unique; `correct` is reserved |
| `title` | string | up to 40 characters, non-empty |
| `description` | string | up to 300 characters (must be present; non-empty for `type`) |
| `emoji` | string | optional, up to 8 characters |
| `minScore` | integer | `level` only (required there): 0 to 2000, the lowest total that reaches this level |
| `goodMatch`, `badMatch` | string | `type` only, optional: the `key` of another (or the same) result type. Omit the field for "none"; an empty string is rejected |

`tieResults[]` (only with `tieRule: "custom"` on `type` quizzes):

| Field | Type | Notes |
|---|---|---|
| `typeKeys` | string[] | 2 to 12 result type keys that tie |
| `title` | string | 1 to 40 characters |
| `description` | string | 1 to 300 characters |

### Rules per kind

| Kind | Choices per question | `weights` | `resultTypes` |
|---|---|---|---|
| `score` | exactly 4 | exactly one choice has `{"correct": 1}`; the others `{}` | not used (`[]`) |
| `type` | 2 to 6 | each choice gives points to at least one declared result type key | 2 to 16 |
| `level` | 2 to 6 | exactly `{"points": n}` with n an integer 0 to 100 (0 is valid) | 2 to 16 levels, each with `minScore` |
| `balance` | exactly 2 | not used (`{}`) | not used (`[]`) |
| `worldcup` | no questions | not used | exactly 8 or 16 candidates; `title`s must be unique (compared after trimming and NFC normalization, case-sensitive) |

Notes:

- For `type`, every result type must be reachable (as the winner, or as part of a tie) by some combination of answers; otherwise validation reports `unreachable_type`. If the quiz is too large to check exhaustively, a `reachability_unknown` warning is returned instead.
- `tieRule: "order"` resolves ties by the order of `resultTypes`. With `"custom"`, every reachable tie between result types must be covered by a `tieResults` entry whose `typeKeys` is exactly that set; otherwise validation reports `tie_unresolved`. Use `"order"` unless you want custom tie results.
- For `level`, the level is the last one whose `minScore` is at most the player's total points. The first `minScore` must be 0 and they must strictly increase. `tieRule` must be `"order"` and `tieResults` `[]` (`level_has_ties`). A `minScore` above the highest possible total is `level_unreachable`; a level no possible total falls into is a `level_empty` warning.
- Matching (`type` only): `goodMatch` and `badMatch` name a result type of the same quiz (`match_unknown_type` if it is not one). On one type they must differ from each other (`match_same`). On other kinds they are rejected (`match_not_supported`), and `minScore` outside `level` is `min_score_not_allowed`.
- Run `GET /api/v1/guide?format=json&lang=en` for complete, always-current examples; they are what the server itself accepts.

### Axis form for `type`

When a personality result is a combination of traits, send `kind: "type"` with `axes` instead of `resultTypes`, `tieRule`, `tieResults` and `weights`; the server expands it into an ordinary `type` quiz. `GET /api/v1/guide?kind=type` has the full rules and an example.

| Field | Notes |
|---|---|
| `axes` | 2 to 4 axes, each `{ "poles": [{ "key", "label" }, { "key", "label" }] }`; pole `key` matches `^[a-z0-9]{1,4}$`, `label` up to 12 characters |
| `results` | exactly one per combination of poles (2 axes: 4, 3 axes: 8, 4 axes: 16): `{ "poles": [one pole key per axis, in axis order], "title", "description", "emoji"?, "goodMatch"?, "badMatch"? }` |
| `questions[].axis` | index of the axis the question measures (0-based) |
| `questions[].choices[].pole` | the pole key (of that axis) the choice leans to |

`goodMatch` and `badMatch` here are arrays of pole keys in the same shape as `poles`. Sending `resultTypes`, `tieResults`, `tieRule` or `weights` with `axes` is rejected (`axes_mixed`), and `axes` on a kind other than `type` is `axes_kind`. Issue `path`s refer to the body you sent, not the expanded quiz.

## Issues (validation results)

Every problem is an issue object:

```json
{ "code": "tie_unresolved", "message": "...", "path": ["tieResults"], "typeKeys": ["adventure", "healing"] }
```

- `code`: stable machine-readable string.
- `message`: human-readable text in the requested `lang`.
- `path`: location in the request body (array of property names and indexes; `[]` means the whole body).
- `typeKeys`: present **only** on `tie_unresolved`. It lists the `resultTypes[].key` values of the tying combination, in `resultTypes` order, so a client can add the missing `tieResults` entry without parsing the message.

`blockers` stop publishing; `warnings` do not. Each list is capped at 100 items. When capped, the response also has `truncated: true`, `totalBlockers` and `totalWarnings`.

Issue codes:

- Generic field checks: `required`, `invalid_type`, `too_short`, `too_long`, `invalid_value`, `unrecognized_keys`, `invalid_input`, `out_of_range`.
- Kind and structure rules: `reserved_type_key`, `bracket_has_questions`, `bracket_has_ties`, `candidate_count`, `no_questions`, `too_many_types`, `too_few_types`, `type_description_empty`, `choice_count`, `duplicate_type_key`.
- Content rules: `title_empty`, `candidate_title_empty`, `candidate_title_too_long`, `candidate_title_duplicate`, `type_title_empty`, `type_title_too_long`, `tie_unknown_type`, `question_body_empty`, `choice_label_empty`, `unknown_weight_key`, `choice_no_weight`, `no_correct_answer`, `multiple_correct_answers`, `unreachable_type`, `reachability_unknown`, `tie_unresolved`.
- Axis form, level and matching: `axes_mixed`, `axes_kind`, `duplicate_pole_key`, `level_has_ties`, `min_score_not_allowed`, `level_first_not_zero`, `level_not_increasing`, `level_unreachable`, `level_empty` (warning), `match_unknown_type`, `match_same`, `match_not_supported`, and `axis_*` codes for axis-form mistakes.

- Cover: `cover_save_failed` is a **warning** that appears only in a successful publish response: the quiz is published but its cover could not be saved, so it shows the default cover. It is never a blocker, so it is not in the guide's blocker list.

`GET /api/v1/guide?format=json` lists each blocker code with a hint on how to fix it.

## Errors

Every error uses one shape:

```json
{ "ok": false, "lang": "en", "error": { "code": "rate_limited", "message": "..." } }
```

| HTTP | `error.code` | When | Notes |
|---|---|---|---|
| 200 | `validation_failed` | `validate` found blockers | only on `/tests/validate`; includes `blockers`, `warnings` |
| 400 | `validation_failed` | `POST /tests` found blockers | nothing was saved; includes `blockers`, `warnings` |
| 400 | `invalid_json` | empty, incomplete or non-JSON/non-UTF-8 body | |
| 400 | `invalid_value` | unknown `kind` or `format` on `/guide` | |
| 413 | `payload_too_large` | body over 64 KiB | |
| 415 | `unsupported_media_type` | `Content-Type` is not `application/json` | |
| 429 | `rate_limited` | too many requests from your network address | `Retry-After` header, in seconds |
| 500 | `internal` | unexpected server error | nothing was saved |
| 502 | `publish_unknown` | the server cannot confirm whether the quiz was saved | **outcome unknown**; do not blindly retry |
| 503 | `unavailable` | temporary backend or rate-limit service outage | `Retry-After: 30`; nothing was saved |
| 503 | `feature_unavailable` | the quiz uses a feature this server has not enabled yet; `error.feature` is `level` or `match` (`goodMatch`/`badMatch`) | no `Retry-After` (waiting does not help); nothing was saved. `error.message` says what to remove, then publish again |

A 5xx error object may also carry `"saved": false`. The server can include it when it is certain that nothing was saved:

```json
{ "ok": false, "lang": "en", "error": { "code": "unavailable", "message": "...", "saved": false } }
```

A client may then treat the failure as definite (the CLI exits `4` for any 5xx with `error.saved === false`, whatever the code). Only the boolean `false` counts. When `saved` is absent or has any other value, an unrecognized 5xx on `POST /api/v1/tests` means the outcome is unknown, like `publish_unknown`.

Rate limiting applies per client address, separately to validating and to publishing. When limited, wait the number of seconds in `Retry-After` before trying again. The limits can change, so rely on the header rather than hard-coded numbers.

## Example

```sh
curl -sS 'https://letsplayquiz.net/api/v1/tests/validate?lang=en' \
  -H 'Content-Type: application/json' \
  -d '{
    "kind": "balance",
    "title": "Ramen or udon?",
    "questions": [
      { "body": "Late-night snack", "choices": [{ "label": "Ramen", "weights": {} }, { "label": "Udon", "weights": {} }] }
    ],
    "resultTypes": [],
    "tieRule": "order",
    "tieResults": []
  }'
```
