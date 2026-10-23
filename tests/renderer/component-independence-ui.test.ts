import { afterAll, beforeAll, expect, test } from "bun:test";
import { chromium, type Browser } from "playwright-core";
import { startFixtureServer, type FixtureServer } from "../helpers/fixture-server";

let browser:Browser;let server:FixtureServer;let url:string;
beforeAll(async()=>{
  const reservation=Bun.serve({port:0,fetch:()=>new Response("reserved")});const port=reservation.port!;reservation.stop(true);
  url=`http://127.0.0.1:${port}/ui-harness.html`;
  server=startFixtureServer({cmd:["bun","./node_modules/vite/bin/vite.js","--host","127.0.0.1","--port",String(port),"--strictPort"],url});
  await server.ready;
  browser=await chromium.launch({executablePath:process.env.DASH_BORED_BROWSER_EXECUTABLE??"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",headless:true,timeout:15_000});
},30_000);
afterAll(async()=>{try{await browser?.close();}finally{await server?.stop();}},30_000);

test("an unrelated package uses the generic action editor and package template insertion",async()=>{
  const page=await browser.newPage({viewport:{width:1280,height:900}});page.setDefaultTimeout(5000);
  try{
    await page.goto(url);await page.getByRole("button",{name:"Open component library",exact:true}).waitFor();
    await page.evaluate(async()=>{
      const host=window.__DASH_BORED_UI_HARNESS_HOST__!;
      host.registerComponentFixture({reference:"./components/external/vendor/actuator",source:"external",available:true,diagnostics:[],manifest:{schemaVersion:3,apiVersion:"2.0.0",id:"vendor/actuator",name:"Vendor actuator",description:"An independent author",entry:"./index.tsx",labelProps:["caption"],propsSchema:{type:"object",additionalProperties:false,properties:{caption:{type:"string",default:"Vendor action"},trigger:{type:"string",format:"action-reference"}}},references:{trigger:{resource:"action"}}}},{componentId:"vendor/actuator",revision:"vendor-one",css:"",javascript:'export default ({props,host}) => globalThis.__DASH_BORED_COMPONENT_RUNTIME__.React.createElement("button",{onClick:()=>host.actions.invoke(props.trigger)},props.caption);'});
      host.registerTemplateFixture({id:"vendor-recipe",reference:"./components/external/vendor#recipe",name:"Vendor recipe",root:{id:"launcher",component:"./components/external/vendor/actuator",props:{caption:"From recipe",trigger:"focus:launcher"}}});
      const snapshot=await host.getSnapshot();
      await host.saveDashboardConfig({schemaVersion:4,name:"Independent package",root:{id:"root",component:"./components/external/core/group",children:{node:{id:"target",component:"./components/external/core/markdown",props:{content:"Independent target"}}}}},snapshot.configRevision!);
    });
    await page.getByText("Independent target",{exact:true}).waitFor();
    await page.getByRole("button",{name:"Open component library",exact:true}).click();
    await page.getByRole("button",{name:"Insert Vendor actuator",exact:true}).click();
    const dialog=page.getByRole("dialog",{name:"Add component"});await dialog.waitFor();
    expect(await dialog.getByRole("combobox",{name:"Action property",exact:true}).inputValue()).toBe("trigger");
    await dialog.getByRole("combobox",{name:"Target node",exact:true}).selectOption({label:"Markdown · target"});
    await dialog.getByRole("button",{name:"Use selected target",exact:true}).click();
    await dialog.getByRole("button",{name:"Add component",exact:true}).click();
    await page.getByRole("dialog",{name:"Component library"}).getByRole("button",{name:"Close Component library",exact:true}).click();
    await page.getByRole("button",{name:"Save dashboard",exact:true}).click();
    let saved=await page.evaluate(()=>window.__DASH_BORED_UI_HARNESS_HOST__!.getPersistedConfig());
    expect(JSON.stringify(saved)).toContain('"trigger":"focus:target"');
    for(let index=0;index<2;index++){
      await page.getByRole("button",{name:"Open component library",exact:true}).click();
      await page.getByRole("button",{name:"Vendor recipe",exact:true}).click();
      await page.getByRole("button",{name:"Save dashboard",exact:true}).click();
    }
    saved=await page.evaluate(()=>window.__DASH_BORED_UI_HARNESS_HOST__!.getPersistedConfig());
    const serialized=JSON.stringify(saved);
    expect(serialized).toContain('"trigger":"focus:launcher"');
    expect(serialized).toContain('"trigger":"focus:launcher-2"');
    expect(await page.getByRole("button",{name:"From recipe",exact:true}).count()).toBe(2);
  }finally{await page.close();}
},30_000);


test("a native surface is initialized again after its URL becomes invalid and then valid", async () => {
  const page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
  page.setDefaultTimeout(5000);
  try {
    await page.goto(url);
    await page.getByRole("button", { name: "Open component library", exact: true }).waitFor();
    await page.evaluate(async () => {
      const host = window.__DASH_BORED_UI_HARNESS_HOST__!;
      host.registerComponentFixture({ reference: "./components/vendor/native-panel", source: "local", available: true, diagnostics: [], manifest: { schemaVersion: 3, apiVersion: "2.0.0", id: "vendor/native-panel", name: "Native panel", description: "Dynamic native surface", entry: "./index.tsx", propsSchema: {}, permissions: ["webview:embed"] } }, { componentId: "vendor/native-panel", revision: "native-test", css: "", javascript: `export default function View({host}) { const R = globalThis.__DASH_BORED_COMPONENT_RUNTIME__.React; const [valid,setValid] = R.useState(true); return R.createElement(R.Fragment,null,R.createElement("button",{onClick:()=>setValid(!valid)},"Toggle URL"),host.webview.render({url:valid?"https://example.com":"invalid",style:{width:400,height:200}})); }` });
      const snapshot = await host.getSnapshot();
      await host.saveDashboardConfig({ schemaVersion: 4, name: "Native lifecycle", root: { id: "dynamic", component: "./components/vendor/native-panel" } }, snapshot.configRevision!);
    });
    const surface = page.locator("electrobun-webview");
    await page.waitForFunction(() => (document.querySelector("electrobun-webview") as HTMLElement | null)?.style.width === "400px");
    await page.getByRole("button", { name: "Toggle URL", exact: true }).click();
    await page.getByRole("alert").getByText("Native webviews require an absolute HTTP or HTTPS URL.").waitFor();
    expect(await surface.count()).toBe(0);
    await page.getByRole("button", { name: "Toggle URL", exact: true }).click();
    await page.waitForFunction(() => (document.querySelector("electrobun-webview") as HTMLElement | null)?.style.width === "400px");
    expect(await surface.evaluate(element => element.style.height)).toBe("200px");
  } catch (error) { throw new Error(`${String(error)}\n${await page.locator("body").innerText()}\n${await page.locator("electrobun-webview").evaluateAll(elements => elements.map(element => element.outerHTML))}`); } finally { await page.close(); }
}, 30_000);
