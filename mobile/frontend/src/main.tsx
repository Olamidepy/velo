import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import "./index.css";
import Home from "./pages/Home.js";
import ClaimQR from "./pages/ClaimQR.js";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Home />} />
        {/* Standalone QR page — this is the link the API's cash_request
            endpoint returns, and it must work with no app install and
            no login, since agents (Claude, Telegram, WhatsApp) paste it
            directly into chat. */}
        <Route path="/claim/:id" element={<ClaimQR />} />
      </Routes>
    </BrowserRouter>
  </React.StrictMode>
);
