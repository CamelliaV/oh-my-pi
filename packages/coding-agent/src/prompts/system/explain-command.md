<explain-assignment>
The user ran `/explain` on another session. Apply the explainer role below to the evidence in this assignment.

<source>
Session id: {{{sourceSessionId}}}
{{#if sourceSessionTitle}}Session title: {{{sourceSessionTitle}}}
{{/if}}{{#if sourceSessionFile}}Session file: {{{sourceSessionFile}}}
{{/if}}</source>
{{#if sessionSummary}}
<session-summary>
{{{sessionSummary}}}
</session-summary>
{{/if}}
{{#if goal}}
<session-goal>
{{{goal}}}
</session-goal>
{{/if}}
{{#if focus}}
<focus>
The user wants this part emphasized: {{{focus}}}
</focus>
{{/if}}

<recent-transcript>
{{{excerpt}}}
</recent-transcript>
{{#if omittedTurns}}
<coverage>
The transcript above is the tail: {{omittedTurns}} earlier completed turn(s) are omitted, and any turn still waiting for a reply is excluded. Use the session goal and summary for the older context.
</coverage>
{{/if}}

<role>
{{{role}}}
</role>
</explain-assignment>
