import { useCallback, useState } from "react";
import { createRoot } from "react-dom/client";
import { ComponentVisibilityContext } from "./ComponentCompositor";
import { ComponentWebviewSurface } from "./ComponentWebviewSurface";
import "./styles.css";

function NativeWebviewProbe() {
  const [visible, setVisible] = useState(true);
  const [sync, setSync] = useState("Waiting for the native surface…");
  const onNativeSurfaceSync = useCallback(({ visible: nextVisible, mounted }: { visible: boolean; mounted: boolean }) => {
    setSync(`Native surface ${mounted ? "mounted" : "not mounted"}; requested ${nextVisible ? "visible + dimensions sync" : "hidden"}.`);
  }, []);
  return (
    <main className="native-probe" aria-label="Native webview probe">
      <span className="eyebrow">Isolated native proof</span>
      <h1>Native webview visibility probe</h1>
      <p>
        This separate Electrobun window is manual evidence only. Toggle the surface and verify that the webview disappears and returns at the correct size.
      </p>
      <button className="button button--primary" type="button" onClick={() => setVisible((current) => !current)}>
        {visible ? "Hide native webview" : "Show native webview"}
      </button>
      <p role="status">{sync}</p>
      <ComponentVisibilityContext.Provider value={visible}>
        <ComponentWebviewSurface url="https://example.com" title="Native probe content" onNativeSurfaceSync={onNativeSurfaceSync} />
      </ComponentVisibilityContext.Provider>
    </main>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("The native probe root is missing.");
createRoot(root).render(<NativeWebviewProbe />);
