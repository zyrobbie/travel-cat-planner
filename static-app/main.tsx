import React from "react";
import { createRoot } from "react-dom/client";
import LocalEntry from "./LocalEntry";
import "../src/app/globals.css";
import "./integration.css";
createRoot(document.getElementById("root")!).render(<LocalEntry />);
