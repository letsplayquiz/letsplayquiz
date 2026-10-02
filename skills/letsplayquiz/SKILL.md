---
name: letsplayquiz
description: Make a shareable LetsPlayQuiz quiz together with the user — a friendship quiz, personality test ("which X are you?"), this-or-that balance game, or bracket "world cup" — then validate and publish it with the `letsplayquiz` CLI and hand back the share link. Use this whenever someone wants to create, draft, or publish a quiz, test, poll-style game, 밸런스 게임, 성격/유형 테스트, 우정 테스트, 이상형 월드컵, or 心理テスト/診断 to send to friends, even if they don't say "LetsPlayQuiz" or name a quiz type, and whenever they mention letsplayquiz.net, `npx letsplayquiz`, or `lpqz`.
---

# Make a LetsPlayQuiz quiz with the user

LetsPlayQuiz (https://letsplayquiz.net) turns one link into a quiz friends can play on their phones. The `letsplayquiz` CLI (alias `lpqz`, run with `npx`, nothing to install) talks to its public API: the **server owns every rule**, the CLI never bypasses them. Your job is the part the server can't do: turn a vague idea into a fun, well-balanced quiz the user actually likes, with as little back-and-forth as possible, and publish only when they say so.

The flow:

1. Understand the idea (ask at most a few short questions)
2. Read the guide for the chosen kind
3. Write the whole draft and show it in readable form
4. Revise with the user until they're happy
5. `validate` until it passes
6. Ask before publishing, then `publish`
7. Hand over both links and explain which one is secret

## 1. Understand the idea — short

People come with anything from "make me a quiz" to a fully specified list of questions. Ask only what you can't infer, in one message, at most three questions. Offer choices with a sensible default so the user can answer in one word. Skip questions whose answer is already in the request.

What you need:

- **Kind** — pick from the user's wording when you can:

  | Kind | `kind` | What players get | Good for |
  |---|---|---|---|
  | Score quiz | `score` | "7/10 — you know me well" | "how well do you know me", trivia, fandom facts |
  | Personality test | `type` | "You're the Planner 📅" | "which X are you", 성격/유형 테스트, 診断 |
  | Balance game | `balance` | their picks vs. what most players picked | this-or-that, 밸런스 게임, would-you-rather |
  | World cup | `worldcup` | a winner from an 8/16-candidate bracket | 이상형 월드컵, "best snack", ranking favorites |

- **Topic and audience** — who plays it (close friends, coworkers, a fandom) changes the tone and the jokes.
- **Language** — `ko`, `ja` or `en`. Default to the language the user is writing in; that is also the language players see.
- Only for a score quiz about the user themself ("how well do you know me"): you need the real answers, so ask for them or offer to write questions the user will answer before you mark correct choices. Never invent facts about the user.

If the user says "just make something" or "알아서", don't ask anything — choose, say what you chose in one line, and go straight to the draft.

## 2. Read the guide for that kind

```bash
npx letsplayquiz guide --kind <kind>
```

This prints the current field limits, the kind's rules (question/choice/result counts, how weights work) and a complete example that passes validation. Read it every time instead of relying on memory: the server's rules are the source of truth and can change. Add `--lang ja` or `--lang en` to get the explanations in that language — the example JSON follows `--lang` too (its `locale` and text are in that language), so copying it keeps the quiz in the language the user is working in.

Server address: the CLI defaults to `https://letsplayquiz.net`. Use `--api <url>` (or the `LETSPLAYQUIZ_API` env var) only when the user points you at another server, e.g. a local dev server.

## 3. Write the whole draft, show it readable

Write the full quiz as JSON in a file (e.g. `quiz.json` in the working directory), but **show the user a readable version, not the JSON** — most people can't review JSON, and they need to see the content to react to it. For example:

```
📝 나는 단톡방에서 어떤 친구?  (유형형 · 한국어 · 템플릿 candy)
알림 999+ 앞에서 드러나는 진짜 나. 질문 8개로 알아보는 단톡방 캐릭터

결과 유형
  🙌 리액션 요정 — 누가 무슨 말만 해도 ㅋㅋㅋ로 답하는 단톡방의 에너지…
  👀 조용한 눈팅러 — …

Q1. 단톡방에 알림이 999+ 쌓였다. 나는?
  ① 일단 최신 메시지에 ㅋㅋㅋ부터 단다 → 리액션 요정
  ② 조용히 읽기만 하고 나온다 → 조용한 눈팅러
  …
```

Show which result each choice leans toward (personality test) or which choice is correct (score quiz), because that's what the user will want to adjust. End with one line inviting changes, e.g. "바꾸고 싶은 문항이나 결과가 있으면 말씀해 주세요. 괜찮으면 검사하고 발행 준비를 할게요."

### What makes each kind fun

- **Personality test (`type`)** — 3–5 result types that feel distinct and flattering; everyone should like their result. 6–10 questions with 3–4 choices each. Give each choice 2 points to its main type and optionally 1 to a neighbor, and make every type the main target of at least one choice per two or three questions, so every result is actually reachable and none dominates. Use `tieRule: "order"` with `tieResults: []` unless the user wants special results for ties. Result descriptions: 1–2 warm, specific sentences that sound like a friend describing you.
- **Score quiz (`score`)** — exactly 4 choices per question, one marked `{"correct": 1}`, the rest `{}`. 5–10 questions. Wrong choices should be plausible; for "how well do you know me", mix easy and hard ones.
- **Balance game (`balance`)** — exactly 2 choices per question, both `{}`. 5–12 questions. Good ones are genuinely hard to choose; keep the two sides similar in length and appeal.
- **World cup (`worldcup`)** — 8 or 16 candidates in `resultTypes` (`key`, `title`, `description` may be `""`), `questions: []`, `tieResults: []`. Candidates are names only (no images); pick ones that are instantly recognizable and roughly comparable.

Write every player-facing string in the quiz's language. Keep titles short (they are the share-card headline). Keys are lowercase `a-z0-9_` and never `correct`.

**Template (`theme`)**: `classic`, `mono`, `candy`, `ocean`, `lemon`, `mint`, `grape`. Pick one that fits the topic (candy for playful/cute, ocean or mint for calm, lemon for bright/food, mono for minimal, grape for moody/fandom) and mention it in the draft so the user can change it. Players automatically see its light or dark version.

## 4. Revise with the user

Apply what they ask, then show only what changed (plus the summary line), not the whole quiz again. If a request would break a rule (e.g. 3 choices in a balance game), say so plainly and offer the closest thing that works. Keep going until they say it's good.

## 5. Validate

```bash
npx letsplayquiz validate quiz.json
```

Nothing is saved. Exit code 0 means it passes (warnings are fine, but read them and mention any that matter). Exit code 1 prints blockers, each with a code and a location — fix them yourself and re-run. Only bring a blocker to the user when fixing it changes their content in a way they'd care about (e.g. a personality type that no choice leads to: ask which questions should point to it, or propose edits).

Other exit codes: 2 = your command or file is wrong (fix and retry); 3 = rate limited (wait for the `Retry-After` it prints); 4 = network or server trouble (tell the user, try later).

## 6. Ask, then publish

Publishing makes the quiz public to anyone with the link and can't be undone from the CLI, so always get an explicit yes first, for example: "검사를 통과했어요. 이대로 발행할까요?" In the same question, ask whether they also want to request the main-page listing (an admin can approve it, or it lists itself once enough people play it): "메인에도 공개 신청할까요?" **Recommend against it** for quizzes with private details (friends' names, inside jokes, a coworker's name) — say so plainly rather than just asking. If they say yes, add `"requestListing": true` to the JSON before publishing (omit it, or leave it `false`, otherwise — the default is no request). If you asked and they said yes, publish with `--json` so you can read back the `listing` field and confirm it:

```bash
npx letsplayquiz publish quiz.json --json
```

- Exit code 0's JSON has `url` (the share link), `ownerUrl` (the results dashboard), and `listing` (`"none"` or `"requested"`). Tell the user which one it is — if `"requested"`, mention that it'll appear on the main page once an admin approves it or enough people play it, and that they can check or cancel this from the dashboard link. (Without `--json`, the CLI only prints `url`/`ownerUrl` in human-readable form — use `--json` whenever you asked about listing, so you have something to report back.)
- **Exit code 5 means the result is unknown** — it may already be published. Do not publish again (that could create a duplicate); tell the user and suggest checking `npx letsplayquiz list` or trying the share link.
- The CLI appends the result to `~/.config/letsplayquiz/tests.jsonl` so `npx letsplayquiz list` can show it later. If the user doesn't want a local record, add `--no-save`.

## 7. Hand over the links

Give both links and be clear about the difference:

- **Share link** (`url`) — send this to friends.
- **Dashboard link** (`ownerUrl`) — shows everyone's results. There is no login, so this link is the only proof they made the quiz and **it can't be reissued**. Tell them to save it and never post it publicly.

Close with one friendly suggestion, like sharing it in the group chat the quiz is about.
