// frontend/js/portal.js
// Parent self-service portal: phone-number lookup, NO OTP verification
// (removed by product decision - see backend/routes/parentPortal.js for
// the security tradeoff notes). Anyone who enters a valid parent phone
// number for this school sees that parent's schoolClass info.

import { API_BASE } from "./firebase-config.js";

// schoolId comes from the URL: portal.html?school=<schoolId>
const params = new URLSearchParams(window.location.search);
const schoolId = params.get("school");

let currentPhone = null;

function showView(id) {
  ["phoneView", "profileView", "notFoundView"].forEach((v) => {
    document.getElementById(v).classList.toggle("hidden", v !== id);
  });
}

window.addEventListener("DOMContentLoaded", () => {
  if (!schoolId) {
    document.getElementById("phoneView").innerHTML =
      "<h1>Elimu Smart</h1><p class='error'>No school specified in this link. Please ask your admin for the correct link.</p>";
    return;
  }

  document.getElementById("findCellBtn").addEventListener("click", async () => {
    const errorEl = document.getElementById("phoneError");
    errorEl.textContent = "";
    const raw = document.getElementById("phoneInput").value.trim();

    if (!raw) {
      errorEl.textContent = "Enter your phone number";
      return;
    }

    currentPhone = raw;
    await loadProfile();
  });
});

async function api(path, options = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Request failed (${res.status})`);
  }
  return res.json();
}

function normalizePhoneForWa(phone) {
  const digits = (phone || "").replace(/\D/g, "");
  if (digits.startsWith("0")) return "254" + digits.slice(1);
  if (digits.startsWith("254")) return digits;
  return digits;
}

function buildClickToChatLink(phone, message) {
  const number = normalizePhoneForWa(phone);
  const base = `https://wa.me/${number}`;
  return message ? `${base}?text=${encodeURIComponent(message)}` : base;
}

async function loadProfile() {
  try {
    const { parent, schoolClass } = await api(
      `/portal/me?school=${encodeURIComponent(schoolId)}&phone=${encodeURIComponent(currentPhone)}`
    );

    document.getElementById("welcomeMsg").textContent = `Welcome, ${parent.name}!`;

    const infoEl = document.getElementById("cellInfo");

    if (!schoolClass) {
      infoEl.innerHTML = `<p class="hint">You're not assigned to a schoolClass yet. Contact your school admin.</p>`;
      showView("profileView");
      return;
    }

    const meeting = [schoolClass.meetingDay, schoolClass.meetingTime].filter(Boolean).join(" at ") || "TBA";

    let html = `
      <p class="schoolClass-name">${escapeHtml(schoolClass.name)}</p>
      <p class="meta">Teacher: ${escapeHtml(schoolClass.teacherName || "—")}</p>
      <p class="meta">Meets: ${escapeHtml(meeting)}</p>
    `;

    if (schoolClass.whatsappGroupLink) {
      html += `<button class="wa-btn" id="joinGroupBtn" type="button">Join WhatsApp Group</button>
               <p class="hint" style="margin-top:2px;">${formatUpdatedDate(schoolClass.whatsappGroupLinkUpdatedAt)}</p>`;
    }

    if (schoolClass.teacherPhone) {
      const teacherMsg = `Hi ${schoolClass.teacherName || "there"}, this is ${parent.name} from ${schoolClass.name}.`;
      const teacherLink = buildClickToChatLink(schoolClass.teacherPhone, teacherMsg);
      html += `<a href="${teacherLink}" target="_blank" rel="noopener"><button class="wa-btn" type="button">Message My Teacher</button></a>`;
    }

    infoEl.innerHTML = html;

    const joinBtn = document.getElementById("joinGroupBtn");
    if (joinBtn) {
      joinBtn.addEventListener("click", async () => {
        try {
          await api(`/portal/join-group?school=${encodeURIComponent(schoolId)}`, {
            method: "POST",
            body: JSON.stringify({ phone: currentPhone }),
          });
        } catch (err) {
          console.error("Could not record join status:", err.message);
        }
        window.open(schoolClass.whatsappGroupLink, "_blank", "noopener");
      });
    }

    showView("profileView");
  } catch (err) {
    showView("notFoundView");
  }
}

function formatUpdatedDate(ts) {
  if (!ts) return "Link date unknown";
  const seconds = ts._seconds ?? ts.seconds;
  if (seconds === undefined) return "Link date unknown";
  const date = new Date(seconds * 1000);
  return "Link updated " + date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str ?? "";
  return div.innerHTML;
}
