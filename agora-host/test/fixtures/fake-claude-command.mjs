// A fake `claude -p` for session commands: prints the stream-json lines Claude Code 2.1.322 printed
// for /compact and /context on a resumed conversation (captured with a real CLI). FAKE_MODE picks the case.
let prompt = '';
for await (const chunk of process.stdin) prompt += chunk;
const mode = process.env.FAKE_MODE ?? 'compact';
const out = (o) => console.log(JSON.stringify(o));
const sid = 'e226743b-163a-46d5-83fd-06200f51bd18';
out({ type: 'system', subtype: 'init', session_id: sid, args: process.argv.slice(2), prompt });
if (mode === 'compact') {
    out({ type: 'system', subtype: 'status', status: 'compacting', session_id: sid });
    out({ type: 'system', subtype: 'compact_boundary', session_id: sid, compact_metadata: { trigger: 'manual', pre_tokens: 72447, post_tokens: 14640, cumulative_dropped_tokens: 105279, duration_ms: 9878 } });
    out({ type: 'system', subtype: 'status', status: null, compact_result: 'success', session_id: sid });
    out({ type: 'result', is_error: false, num_turns: 0, result: '', session_id: sid });
} else if (mode === 'too-short') {
    out({ type: 'assistant', message: { model: '<synthetic>', role: 'assistant', content: [{ type: 'text', text: 'Not enough messages to compact.' }] } });
    out({ type: 'result', is_error: false, num_turns: 0, result: 'Not enough messages to compact.', session_id: sid });
} else if (mode === 'context') {
    out({ type: 'assistant', message: { model: '<synthetic>', role: 'assistant', content: [{ type: 'text', text: '## Context Usage\n\n**Model:** claude-opus-5-5  \n**Tokens:** 72.2k / 1m (7%)\n' }] } });
    out({ type: 'result', is_error: false, num_turns: 0, result: '', session_id: sid });
} else if (mode === 'model-turn') {
    // What an unknown slash word does: the model answers it as text
    out({ type: 'assistant', message: { model: 'claude-opus-5-5', role: 'assistant', content: [{ type: 'text', text: 'I do not know that command.' }] } });
    out({ type: 'result', is_error: false, num_turns: 1, result: 'I do not know that command.', session_id: sid });
} else if (mode === 'hang') {
    setInterval(() => {}, 1000);
} else if (mode === 'crash') {
    process.exit(3);
}
