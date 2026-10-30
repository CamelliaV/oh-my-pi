<title-request>
Session UI request, not from the user. Your main reply continues separately; NEVER start on the task here.
{{#if card}}
Name this session for a small card: one icon, a short code, then a 3-6 word title of the user's goal, from the request and the recent turns shown.
{{else}}
Name this session with a 3-6 word title of the user's goal, from the request and the recent turns shown.
{{/if}}
{{#if nerdFonts}}
- nf: the Nerd Fonts class name of the most specific picture of the subject (`nf-dev-docker`, `nf-md-file_tree`); a logo when the session is about that tool or service. Only a name you are certain exists; never invent one.
- emoji: the same picture as an emoji, for where the icon font is missing. Never a generic ✨, 🚀, 🔧, ⚙️ or 🧩.
{{else if card}}
- emoji: the most specific emoji picture of the subject (🐳 for Docker, 🌲 for a directory walker). Never a generic ✨, 🚀, 🔧, ⚙️ or 🧩.
{{/if}}
{{#if card}}
- code: 1-6 capital letters or digits taken from one word of the title (whole word if ≤6 letters, else its first syllable: PROV, FLBK). Never initials of several words unless the user writes them so (CTA, SDK).
{{/if}}
- Title: imperative phrase built from the user's own key words: the feature, component, or error they name.
- No task to name (greeting, acknowledgement, gibberish)? Answer `<title/>`.
- No quotes, trailing punctuation, or explanation.
{{#if nerdFonts}}
Output exactly one line: `<title nf="nf-md-parking" emoji="🅿️" code="PARK">Fix flaky park tests</title>`, or `<title/>`.
{{else if card}}
Output exactly one line: `<title emoji="🅿️" code="PARK">Fix flaky park tests</title>`, or `<title/>`.
{{else}}
Output exactly one line: `<title>Fix flaky park tests</title>`, or `<title/>`.
{{/if}}
</title-request>
