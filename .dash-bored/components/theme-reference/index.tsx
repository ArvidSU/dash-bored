import { defineComponent, useTheme } from '@dash-bored/component';
export default defineComponent(() => {
  const { reference, appearance, tokens } = useTheme();
  return <section style={{ padding: '1rem', color: 'var(--text)' }}>
    <h2>Theme inspection</h2>
    <p><code>{reference}</code> · {appearance}</p>
    <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap' }}>
      {['bg', 'surface', 'text', 'muted', 'accent', 'positive', 'warning', 'negative'].map((name) => <div key={name}>
        <div style={{ width: '3rem', height: '2rem', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border)', background: tokens[name] }} />
        <small>{name}</small>
      </div>)}
    </div>
    <p>Try Ocean in the dashboard theme selector. Settings → Themes controls Light, Dark, or System. Use the Manage theme packages section in that tab to add, update, remove, or sync Git themes for this dashboard or your personal collection.</p>
    <p><code>bun run dash-bored -- theme validate .dash-bored/themes/ocean</code></p>
  </section>;
});
