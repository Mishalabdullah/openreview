/* @refresh reload */
import { render } from "solid-js/web";
import "@fontsource-variable/manrope/index.css";
import "@fontsource-variable/newsreader/index.css";
import "@fontsource/ibm-plex-mono/400.css";
import "./index.css";
import App from "./App.tsx";

const root = document.getElementById("root");

render(() => <App />, root!);
