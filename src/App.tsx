import { BrowserRouter, Routes, Route } from "react-router-dom";

import Home from "./pages/Home";
import PhoneSend from "./pages/PhoneSend";

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/join/:sessionId" element={<PhoneSend />} />
      </Routes>
    </BrowserRouter>
  );
}
