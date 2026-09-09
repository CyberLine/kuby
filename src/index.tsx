/* @refresh reload */
import "@fontsource-variable/ibm-plex-sans";
import "@fontsource-variable/jetbrains-mono";
import { render } from "solid-js/web";
import App from "./App";
import "./stores/theme";
import "./stores/telemetry";

render(() => <App />, document.getElementById("root") as HTMLElement);
