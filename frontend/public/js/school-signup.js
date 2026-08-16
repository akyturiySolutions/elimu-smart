// frontend/js/school-signup.js
// No Firebase Auth SDK needed here - the school and admin account are
// both created server-side via the Admin SDK (backend/routes/churchSignup.js).
// This page just makes plain fetch calls.

import { API_BASE } from "./firebase-config.js";

window.addEventListener("DOMContentLoaded", () => {
  document.getElementById("submitBtn").addEventListener("click", submitSignup);
});

async function submitSignup() {
  const errorEl = document.getElementById("formError");
  errorEl.textContent = "";

  const schoolName = document.getElementById("schoolName").value.trim();
  const email = document.getElementById("email").value.trim();
  const password = document.getElementById("password").value;
  const confirmPassword = document.getElementById("confirmPassword").value;

  if (!schoolName) {
    errorEl.textContent = "School name is required.";
    return;
  }
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
    const res = await fetch(API_BASE + "/school-signup/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ schoolName: schoolName, email: email, password: password }),
    });
    const data = await res.json();

    if (!res.ok) {
      errorEl.textContent = data.error || "Something went wrong. Please try again.";
      return;
    }

    document.getElementById("doneChurchName").textContent = data.schoolName;
    document.getElementById("doneChurchId").textContent = data.schoolId;
    document.getElementById("formView").classList.add("hidden");
    document.getElementById("doneView").classList.remove("hidden");
  } catch (err) {
    errorEl.textContent = "Couldn't reach the server. Please try again in a moment.";
  }
}
