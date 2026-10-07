import { createRoot } from "react-dom/client";
import AccountEntry from "../AccountEntry";
import "../../src/app/globals.css";
import "../integration.css";
createRoot(document.getElementById("root")!).render(<AccountEntry />);
