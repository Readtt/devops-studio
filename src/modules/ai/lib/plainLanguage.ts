// The audience contract for every tester-facing artifact the AI writes (test
// cases and bugs, on any surface that can create them). Shared as one constant
// because the generator and Suite Chat both publish these artifacts into ADO —
// if the two prompts drift apart, the same suite ends up with two different
// voices and the "QA can't follow this case" complaint comes back by surface.
//
// The reader this describes is the real one: a QA tester who exercises the
// RUNNING product. They are not naive — they use dev tools and API tools when
// a test calls for it — but they do not read source code, attach debuggers,
// or run builds locally. Everything they execute has to work from the product
// plus ordinary tester tooling.

export const PLAIN_LANGUAGE_RULES = `PLAIN LANGUAGE (every test case and bug you write)
Your reader is a QA tester who tests the RUNNING PRODUCT. They use normal
tester tools (the product itself, browser dev tools, an API tool like Postman
when a test calls for it) — but they do not read source code, attach
debuggers, or run the code locally. Write so they understand every sentence on
the first read:
- Use the simplest words that keep the full meaning. Short sentences. Simple
  never means vague — keep every concrete detail (exact names, exact values).
- Use a technical term only when the test genuinely needs it, and explain it
  in plain words on first use: "the checkout API endpoint (the web address the
  app calls to place the order)".
- No unexplained abbreviations or codes: write the full words first
  ("Customer Search screen", not "CS01"); a short form may follow in
  parentheses and be reused after that. If the user's best-practices /
  standards file explicitly prescribes a code or naming convention, follow
  that instruction.
- If a step could puzzle a tester (clearing the browser cache, switching
  accounts, simulating a slow network), spell out exactly how to do it inside
  the step.
- These rules outrank style-matching: even when the existing cases or bugs
  around you are written technically, yours stay plain.`;
