// frontend/js/teacher-signup.js
// No Firebase Auth SDK needed here - the account is created server-side
// via the Admin SDK (backend/routes/teacherSignup.js), so this page just
// makes plain fetch calls with the invite token.

import { API_BASE } from "./firebase-config.js";

const params = new URLSearchParams(window.location.search);
const schoolId = params.get("school");
const token = params.get("token");

function showView(id) {
  ["checkingView", "invalidView", "formView", "doneView"].forEach((v) => {
    document.getElementById(v).classList.toggle("hidden", v !== id);
  });
}

window.addEventListener("DOMContentLoaded", async () => {
  if (!schoolId || !token) {
    document.getElementById("invalidReason").textContent =
      "This link is missing information. Please ask your admin to send you the invite link again.";
    showView("invalidView");
    return;
  }

  try {
    const res = await fetch(
      `${API_BASE}/teacher-signup/validate?school=${encodeURIComponent(schoolId)}&token=${encodeURIComponent(token)}`
    );
    const data = await res.json();

    if (!data.valid) {
      document.getElementById("invalidReason").textContent = data.error || "This invite link is not valid.";
      showView("invalidView");
      return;
    }

    document.getElementById("cellNameDisplay").textContent = data.className;
    showView("formView");
  } catch (err) {
    document.getElementById("invalidReason").textContent = "Couldn't check this invite. Please try again in a moment.";
    showView("invalidView");
  }

  document.getElementById("submitBtn").addEventListener("click", submitSignup);
});

async function submitSignup() {
  const errorEl = document.getElementById("formError");
  errorEl.textContent = "";

  const email = document.getElementById("email").value.trim();
  const password = document.getElementById("password").value;
  const confirmPassword = document.getElementById("confirmPassword").value;

  if (!email || !password) {
    errorEl.textContent = "Email and password are required.";
    return;
  }
  if (password.length < 6) {
    errorEl.textContent = "Password must be at least 6 characters.";
    return;
  }
  if (password !== confirmPassword) {
    errorEl.textContent = "Passwords don't match.";
    return;
  }

  try {
    const res = await fetch(`${API_BASE}/teacher-signup/complete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ school: schoolId, token, email, password }),
    });
    const data = await res.json();

    if (!res.ok) {
      errorEl.textContent = data.error || "Something went wrong. Please try again.";
      return;
    }

    document.getElementById("doneCellName").textContent = data.className;
    showView("doneView");
  } catch (err) {
    errorEl.textContent = "Couldn't reach the server. Please try again in a moment.";
  }
}
