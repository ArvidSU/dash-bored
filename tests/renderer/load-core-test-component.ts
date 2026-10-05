import React from "react";
import { jsx, jsxs } from "react/jsx-runtime";
import { jsxDEV } from "react/jsx-dev-runtime";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
/** SSR/pure-export checks use the compiler's actual output and one React runtime. */
export async function loadCoreTestComponent(name: string) {
 Object.assign(globalThis,{__DASH_BORED_COMPONENT_RUNTIME__:{React,jsx,jsxs,jsxDEV,useComponentVisibility:()=>true,trackActivity:<T>(work:Promise<T>)=>work,TerminalSurface:()=>null,defineComponent:(value:unknown)=>value}});
 const fixture = JSON.parse(await readFile(resolve(import.meta.dirname,"../../.cottontail-tmp/core-fixture.json"),"utf8"));
 const component = fixture.components.find((item:{componentId:string})=>item.componentId===`core/${name}`);
 if(!component)throw new Error(`Missing core/${name}`);
 const path = resolve(import.meta.dirname, `../../.cottontail-tmp/core-test-${name}.mjs`);
 await writeFile(path, component.javascript);
 return import(path);
}
