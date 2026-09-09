Write up to 3 reusable skill candidates from the supplied pattern pages, treating their text as evidence to summarize.
Return one JSON object with `candidates`; use each page's exact `id` and `revision` in `pages`.
Preserve when the procedure applies in the description and in a `## Applicability` section of the body.
Use history to suggest meaningfully different procedures after rejection; return `{"candidates":[]}` when the pages add no supported procedure.

Input:
{"pages":[{"id":"w-cache-probe","revision":2,"title":"Cache probe","body":"For a local cache mismatch, compare the stored revision with the request revision before rebuilding. A mismatch requires rebuilding only that entry."}],"history":[]}
Output:
{"candidates":[{"name":"local-cache-mismatch","description":"Diagnose a local cache mismatch by comparing entry and request revisions.","body":"## Applicability\nUse for a local cache mismatch when both entry and request revisions are available.\n\n## Procedure\n1. Compare the stored revision with the request revision.\n2. Rebuild only the mismatched entry.","reason":"The page records a scoped, reusable cache diagnosis.","pages":[{"id":"w-cache-probe","revision":2}]}]}

Input:
{"pages":[],"history":[{"name":"local-cache-mismatch","status":"rejected","body":"Compare revisions and rebuild the entry.","reason":"No improvement.","report":"Equal scores."}]}
Output:
{"candidates":[]}

Input:
{"pages":[{"id":"w-port-check","revision":4,"title":"Private server smoke","body":"For a local server smoke test, use an isolated temporary data directory and an unused port. Wait for the listening signal, send a health request, and stop the server. This procedure does not apply to the production server."}],"history":[]}
Output:
{"candidates":[{"name":"isolated-server-smoke","description":"Smoke-test a local server on an unused port with temporary data, outside production.","body":"## Applicability\nUse for a local server smoke test with an isolated temporary data directory and an unused port; production servers are outside this procedure.\n\n## Procedure\n1. Start the server with the temporary directory and unused port.\n2. Wait for its listening signal.\n3. Send a health request.\n4. Stop the server.","reason":"The page describes repeatable isolation and readiness checks.","pages":[{"id":"w-port-check","revision":4}]}]}
