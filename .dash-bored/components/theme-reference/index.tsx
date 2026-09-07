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
    <p>Use Settings → Themes to set app defaults or preview this dashboard’s own theme and appearance before saving. The command palette also offers Set default theme and Set dashboard theme, each guiding you through the package and Light, Dark, or System choice. Use the Manage theme packages section to add, update, remove, or sync Git themes for this dashboard or your personal collection.</p>
    <p><code>bun run dash-bored -- theme validate .dash-bored/themes/retro-industrial</code></p>
  </section>;
});
