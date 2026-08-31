// frontend/js/admin.js
import { auth, API_BASE } from "./firebase-config.js";
import {
  signInWithEmailAndPassword,
  signOut,
  onAuthStateChanged,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
// BUILD_VERSION: bump this string every time you deploy a real change.
// Printed to the console on every page load - the fastest way to check
// "is my latest deploy actually live?" without digging through DevTools
// Network tab. Just open the console after a deploy and compare.
const BUILD_VERSION = "2026-08-20-edit-parent";
console.log("Elimu Smart admin.js build:", BUILD_VERSION);

let currentToken = null;
let classesCache = [];
let parentsCache = [];
let editingClassId = null;
let currentRole = "admin";
let currentClassId = null;
let currentSchoolId = null;

// ---------- Auth ----------

window.login = async function () {
  const email = document.getElementById("loginEmail").value.trim();
  const password = document.getElementById("loginPassword").value;
  const errorEl = document.getElementById("loginError");
  errorEl.textContent = "";

  try {
    await signInWithEmailAndPassword(auth, email, password);
  } catch (err) {
    errorEl.textContent = "Login failed: " + err.message;
  }
};

window.logout = async function () {
  stopTokenRefreshTimer();
  await signOut(auth);
};

// Firebase ID tokens expire after 1 hour. getIdToken() inside api() already
// refreshes automatically when a token has expired, and api() also retries
// once on a 401 as a fallback - but proactively refreshing every 45 minutes
// means a session left open all day never even hits that edge case.
let tokenRefreshTimer = null;
function startTokenRefreshTimer() {
  stopTokenRefreshTimer();
  tokenRefreshTimer = setInterval(async () => {
    if (auth.currentUser) {
      try {
        currentToken = await auth.currentUser.getIdToken(true);
      } catch {
        // network hiccup during background refresh - next api() call will retry
      }
    }
  }, 45 * 60 * 1000);
}
function stopTokenRefreshTimer() {
  if (tokenRefreshTimer) {
    clearInterval(tokenRefreshTimer);
    tokenRefreshTimer = null;
  }
}

onAuthStateChanged(auth, async (user) => {
  if (user) {
    currentToken = await user.getIdToken();
    startTokenRefreshTimer();
    document.getElementById("loginView").classList.add("hidden");
    document.getElementById("appView").classList.remove("hidden");

    const claims = decodeJwtPayload(currentToken);
    currentRole = claims?.role || "admin"; // pre-role accounts default to admin
    currentClassId = claims?.classId || null;
    currentSchoolId = claims?.schoolId || null;

    if (claims?.schoolId) {
      const portalUrl = `${window.location.origin}/portal.html?school=${encodeURIComponent(claims.schoolId)}`;
      document.getElementById("portalLinkDisplay").value = portalUrl;
    }

    applyRoleUI();
    await loadClasses();
    await loadParents();
    populateAnalyticsClassSelect();

    // Now that parentsCache is populated, actually render the roll call
    // for teachers (dropdown was pre-selected in loadClasses above).
    if (currentRole === "teacher" && document.getElementById("attendanceClass").value) {
      await window.loadAttendanceForm();
    }

    if (currentRole === "teacher") {
      await loadMyLessonPlans();
      await loadApprovedLessonPlansForHomework();
      await loadMyHomework();
    } else {
      await loadLessonPlanReviewQueue();
    }
  } else {
    stopTokenRefreshTimer();
    currentToken = null;
    document.getElementById("loginView").classList.remove("hidden");
    document.getElementById("appView").classList.add("hidden");
  }
});

// Shows/hides write-action cards based on role. Admin = full access everywhere.
// Teacher = can create/edit within their own class, but can't create new classes.
// Level 2 click-to-chat buttons (Message, Send Reminder, Send Check-in) are
// left visible for every role since they're plain wa.me links with no
// backend write call - harmless, and useful for admin too.
function applyRoleUI() {
  const badge = document.getElementById("roleBadge");
  if (currentRole === "teacher") {
    badge.textContent = "Role: Class Teacher (your class only)";
  } else {
    badge.textContent = "Role: Admin (full access)";
  }

  const addClassCard = document.getElementById("addClassCard");
  const addParentCard = document.getElementById("addParentCard");
  const bulkAddParentCard = document.getElementById("bulkAddParentCard");
  const saveAttendanceBtn = document.getElementById("saveAttendanceBtn");
  const addLessonPlanCard = document.getElementById("addLessonPlanCard");
  const myLessonPlansCard = document.getElementById("myLessonPlansCard");
  const lessonPlanReviewCard = document.getElementById("lessonPlanReviewCard");
  const addHomeworkCard = document.getElementById("addHomeworkCard");
  const myHomeworkCard = document.getElementById("myHomeworkCard");

  if (currentRole === "teacher") {
    addClassCard.style.display = "none"; // teachers can edit their own class, not create new ones
    addParentCard.style.display = "block";
    bulkAddParentCard.style.display = "block";
    saveAttendanceBtn.style.display = "inline-block";
    setBroadcastCardDisabled(true); // visible, but greyed out - admin-only action
    addLessonPlanCard.style.display = "block";
    myLessonPlansCard.style.display = "block";
    lessonPlanReviewCard.style.display = "none";
    addHomeworkCard.style.display = "block";
    myHomeworkCard.style.display = "block";
  } else {
    // admin gets full access
    addClassCard.style.display = "block";
    addParentCard.style.display = "block";
    bulkAddParentCard.style.display = "block";
    saveAttendanceBtn.style.display = "inline-block";
    setBroadcastCardDisabled(false);
    addLessonPlanCard.style.display = "none"; // admin doesn't author plans, only reviews them
    myLessonPlansCard.style.display = "none";
    lessonPlanReviewCard.style.display = "block";
    addHomeworkCard.style.display = "none"; // admin doesn't author homework either
    myHomeworkCard.style.display = "none";
  }

  // Tab buttons: Classes and Homework are role-specific, hide the whole
  // tab button (not just its content) so a role never sees an empty tab.
  document.getElementById("tabBtnClasses").style.display = currentRole === "teacher" ? "none" : "inline-block";
  document.getElementById("tabBtnHomework").style.display = currentRole === "teacher" ? "inline-block" : "none";

  // Default to the first visible tab on login.
  const firstVisibleBtn = Array.from(document.querySelectorAll(".tab-btn"))
    .find((btn) => btn.style.display !== "none");
  showTab(firstVisibleBtn ? firstVisibleBtn.dataset.tab : "parents");
}

window.showTab = function (tabName) {
  document.querySelectorAll(".tab-panel").forEach((panel) => {
    panel.style.display = panel.id === "panel-" + tabName ? "block" : "none";
  });
  document.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.tab === tabName);
  });
};

// Level 3 (automated sends) is admin-only. Teachers still see the
// card - so they know the capability exists - but can't use it: inputs
// disabled, card visually dimmed, and a note explains why.
function setBroadcastCardDisabled(disabled) {
  const broadcastCard = document.getElementById("broadcastCard");
  broadcastCard.style.display = "block";
  broadcastCard.style.opacity = disabled ? "0.55" : "1";

  const classSelect = document.getElementById("broadcastClass");
  const messageBox = document.getElementById("broadcastMessage");
  const sendBtn = document.getElementById("broadcastSendBtn");
  if (classSelect) classSelect.disabled = disabled;
  if (messageBox) messageBox.disabled = disabled;
  if (sendBtn) sendBtn.disabled = disabled;

  const noteEl = document.getElementById("broadcastLockedNote");
  if (noteEl) noteEl.style.display = disabled ? "block" : "none";
}

window.copyPortalLink = function () {
  const input = document.getElementById("portalLinkDisplay");
  input.select();
  navigator.clipboard.writeText(input.value).then(() => {
    document.getElementById("portalLinkStatus").textContent = "Copied!";
  }).catch(() => {
    document.getElementById("portalLinkStatus").textContent = "Copy failed - select and copy manually.";
  });
};

function decodeJwtPayload(token) {
  try {
    const payload = token.split(".")[1];
    const decoded = atob(payload.replace(/-/g, "+").replace(/_/g, "/"));
    return JSON.parse(decoded);
  } catch {
    return null;
  }
}

// ---------- API helper ----------

// Fires a request with a fresh ID token. If the token was expired or claims
// were just updated server-side (e.g. role/classId changed), the first
// attempt can 401 - in that case we force a real token refresh and retry
// ONCE before giving up, instead of asking the person to log out and back in.
async function api(path, options = {}, isRetry = false) {
  if (!auth.currentUser) {
    throw new Error("You've been signed out - please log in again.");
  }

  const token = await auth.currentUser.getIdToken(isRetry);
  currentToken = token; // keep in sync in case anything still reads currentToken directly

  let res;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        ...(options.headers || {}),
      },
    });
  } catch (networkErr) {
    // The backend on Render's free tier sleeps after inactivity and can
    // take 30-60s to wake up on the first request - this usually shows up
    // as a raw "Failed to fetch" rather than a proper HTTP error.
    throw new Error("Couldn't reach the server. If it's been idle a while it may be waking up - wait a few seconds and try again.");
  }

  if (res.status === 401 && !isRetry) {
    // Force-refresh (getIdToken(true)) and retry exactly once - covers both
    // a genuinely expired token and claims that changed since this session
    // started (e.g. role was updated via create-team-member.js).
    return api(path, options, true);
  }

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Request failed (${res.status})`);
  }
  return res.json();
}

// ---------- WhatsApp link helpers (Level 1 & 2 — no backend call, no API cost) ----------

// Normalizes Kenyan numbers to international digits-only, e.g. 0722914407 -> 254722914407
function normalizePhoneForWa(phone) {
  const digits = (phone || "").replace(/\D/g, "");
  if (digits.startsWith("0")) return "254" + digits.slice(1);
  if (digits.startsWith("254")) return digits;
  return digits;
}

// Level 2: click-to-chat link, optionally with a prefilled message
function buildClickToChatLink(phone, message) {
  const number = normalizePhoneForWa(phone);
  const base = `https://wa.me/${number}`;
  return message ? `${base}?text=${encodeURIComponent(message)}` : base;
}

// ---------- Parents ----------

async function loadParents() {
  const { parents } = await api("/parents");
  parentsCache = parents;
  renderParentsTable(parentsCache);
}

// Groups the given parent list by class (alphabetical by class name, parents
// with no class last), shows a header row per group with its own count, and
// a running total at the top of the card.
function renderParentsTable(list) {
  const tbody = document.getElementById("parentsTable");
  tbody.innerHTML = "";

  document.getElementById("parentTotalCount").textContent =
    "Total parents: " + list.length;

  if (list.length === 0) {
    const tr = document.createElement("tr");
    tr.innerHTML = "<td colspan='5' style='color:var(--ink-soft);'>No parents match.</td>";
    tbody.appendChild(tr);
    return;
  }

  const groups = {}; // classId (or "" for unassigned) -> parents[]
  list.forEach((m) => {
    const key = m.classId || "";
    if (!groups[key]) groups[key] = [];
    groups[key].push(m);
  });

  const groupKeys = Object.keys(groups).sort((a, b) => {
    if (a === "") return 1; // unassigned always last
    if (b === "") return -1;
    const nameA = classesCache.find((c) => c.id === a)?.name || "";
    const nameB = classesCache.find((c) => c.id === b)?.name || "";
    return nameA.localeCompare(nameB);
  });

  groupKeys.forEach((key) => {
    const schoolClass = classesCache.find((c) => c.id === key);
    const groupName = schoolClass ? schoolClass.name : "No Class Assigned";
    const groupMembers = groups[key].sort((a, b) => a.name.localeCompare(b.name));

    const headerTr = document.createElement("tr");
    headerTr.className = "class-group-header";
    headerTr.innerHTML =
      "<td colspan='5'>" + escapeHtml(groupName) + " (" + groupMembers.length + ")</td>";
    tbody.appendChild(headerTr);

    groupMembers.forEach((m) => {
      const welcomeMsg = schoolClass
        ? "Welcome to " + schoolClass.name + "! Glad to have you with us."
        : "Hi " + m.name + ", welcome!";
      const waLink = buildClickToChatLink(m.whatsappNumber || m.phone, welcomeMsg);

      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${escapeHtml(m.childName || "—")}</td>
        <td>${escapeHtml(m.name)}</td>
        <td>${escapeHtml(m.phone)}</td>
        <td>${escapeHtml(groupName)}</td>
        <td class="actions">
          <a href="${waLink}" target="_blank" rel="noopener"><button class="wa-btn" type="button">Message</button></a>
          <button class="edit-parent-btn" data-id="${m.id}">Edit</button>
          <button class="del" data-id="${m.id}">Delete</button>
        </td>`;
      tr.querySelector(".del").addEventListener("click", () => deleteMember(m.id));
      tr.querySelector(".edit-parent-btn").addEventListener("click", () => startEditParent(m.id));
      tbody.appendChild(tr);
    });
  });
}

window.filterParents = function () {
  const classId = document.getElementById("parentSearchClass").value;
  const phoneQuery = document.getElementById("parentSearchPhone").value.replace(/\D/g, "");

  let filtered = parentsCache;
  if (classId) {
    filtered = filtered.filter((m) => m.classId === classId);
  }
  if (phoneQuery) {
    filtered = filtered.filter((m) => (m.phone || "").replace(/\D/g, "").includes(phoneQuery));
  }
  renderParentsTable(filtered);
};

window.clearParentSearch = function () {
  document.getElementById("parentSearchClass").value = "";
  document.getElementById("parentSearchPhone").value = "";
  renderParentsTable(parentsCache);
};

let editingParentId = null;

function startEditParent(id) {
  const parent = parentsCache.find((p) => p.id === id);
  if (!parent) return;

  editingParentId = id;
  document.getElementById("parentChildName").value = parent.childName || "";
  document.getElementById("parentName").value = parent.name || "";
  document.getElementById("parentPhone").value = parent.phone || "";
  document.getElementById("parentWhatsapp").value = parent.whatsappNumber || "";
  document.getElementById("parentClass").value = parent.classId || "";

  document.getElementById("addParentTitle").textContent = "Edit Parent";
  document.getElementById("addParentBtn").textContent = "Save Changes";
  document.getElementById("cancelEditParentBtn").style.display = "inline-block";
  document.getElementById("addParentCard").scrollIntoView({ behavior: "smooth" });
}

window.cancelEditParent = function () {
  editingParentId = null;
  document.getElementById("parentChildName").value = "";
  document.getElementById("parentName").value = "";
  document.getElementById("parentPhone").value = "";
  document.getElementById("parentWhatsapp").value = "";
  document.getElementById("parentClass").value = "";
  document.getElementById("addParentTitle").textContent = "Add Parent";
  document.getElementById("addParentBtn").textContent = "Add Parent";
  document.getElementById("cancelEditParentBtn").style.display = "none";
};

window.addParent = async function () {
  const childName = document.getElementById("parentChildName").value.trim();
  const name = document.getElementById("parentName").value.trim();
  const phone = document.getElementById("parentPhone").value.trim();
  const whatsappNumber = document.getElementById("parentWhatsapp").value.trim();
  const classId = document.getElementById("parentClass").value || null;

  if (!name || !phone) {
    alert("Parent name and phone are required");
    return;
  }

  try {
    if (editingParentId) {
      await api(`/parents/${editingParentId}`, {
        method: "PUT",
        body: JSON.stringify({ childName, name, phone, whatsappNumber: whatsappNumber || phone, classId }),
      });
    } else {
      await api("/parents", {
        method: "POST",
        body: JSON.stringify({ childName, name, phone, whatsappNumber: whatsappNumber || undefined, classId }),
      });
    }
  } catch (err) {
    alert("Couldn't save parent: " + err.message);
    return;
  }

  window.cancelEditParent();
  await loadParents();
};

// Parses one parent per line: "Name, Phone" or just "Phone" alone (name
// then defaults to the phone number itself - rename later if needed by
// deleting and re-adding, since there's no bulk-edit yet).
function parseBulkMemberText(text) {
  const lines = text.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);

  return lines.map((line) => {
    const commaIndex = line.indexOf(",");
    if (commaIndex === -1) {
      return { name: line, phone: line };
    }
    const name = line.slice(0, commaIndex).trim();
    const phone = line.slice(commaIndex + 1).trim();
    return { name: name || phone, phone: phone };
  }).filter((m) => m.phone);
}

window.bulkAddParents = async function () {
  const classId = document.getElementById("bulkParentClass").value || null;
  const text = document.getElementById("bulkMemberText").value;
  const statusEl = document.getElementById("bulkAddStatus");

  const parents = parseBulkMemberText(text);

  if (parents.length === 0) {
    statusEl.textContent = "Paste at least one line first.";
    return;
  }

  statusEl.textContent = "Adding " + parents.length + " parent(s)...";

  try {
    const result = await api("/parents/bulk", {
      method: "POST",
      body: JSON.stringify({ classId: classId, parents: parents }),
    });
    statusEl.textContent = "Added " + result.created + " parent(s)" +
      (result.skipped ? ", skipped " + result.skipped + " invalid line(s)" : "") + ".";
    document.getElementById("bulkMemberText").value = "";
    await loadParents();
  } catch (err) {
    statusEl.textContent = "Error: " + err.message;
  }
};

async function deleteMember(id) {
  if (!confirm("Delete this parent?")) return;
  await api(`/parents/${id}`, { method: "DELETE" });
  await loadParents();
}

// ---------- Classes ----------

async function loadClasses() {
  const { classes } = await api("/classes");
  classesCache = classes;

  const select = document.getElementById("parentClass");
  select.innerHTML = '<option value="">-- No Class --</option>';
  classes.forEach((c) => {
    const opt = document.createElement("option");
    opt.value = c.id;
    opt.textContent = c.name;
    select.appendChild(opt);
  });

  const broadcastSelect = document.getElementById("broadcastClass");
  broadcastSelect.innerHTML = '<option value="">-- Choose a Class --</option>';
  classes.forEach((c) => {
    const opt = document.createElement("option");
    opt.value = c.id;
    opt.textContent = c.name;
    broadcastSelect.appendChild(opt);
  });

  const bulkParentSelect = document.getElementById("bulkParentClass");
  bulkParentSelect.innerHTML = '<option value="">-- Choose a Class --</option>';
  classes.forEach((c) => {
    const opt = document.createElement("option");
    opt.value = c.id;
    opt.textContent = c.name;
    bulkParentSelect.appendChild(opt);
  });

  const parentSearchSelect = document.getElementById("parentSearchClass");
  parentSearchSelect.innerHTML = '<option value="">-- All classes --</option>';
  classes.forEach((c) => {
    const opt = document.createElement("option");
    opt.value = c.id;
    opt.textContent = c.name;
    parentSearchSelect.appendChild(opt);
  });

  const attendanceSelect = document.getElementById("attendanceClass");
  attendanceSelect.innerHTML = '<option value="">-- Choose a Class --</option>';
  classes.forEach((c) => {
    const opt = document.createElement("option");
    opt.value = c.id;
    opt.textContent = c.name;
    attendanceSelect.appendChild(opt);
  });
  const dateInput = document.getElementById("attendanceDate");
  if (!dateInput.value) dateInput.value = new Date().toISOString().slice(0, 10);

  // Teachers only ever have one class (the backend already scopes GET /classes
  // to it) - pre-select it so roll call is one less tap. The actual
  // attendance form loads after loadParents() too (see onAuthStateChanged),
  // since it needs parentsCache populated first.
  if (currentRole === "teacher" && classes.length === 1) {
    attendanceSelect.value = classes[0].id;
  }

  const tbody = document.getElementById("classesTable");
  tbody.innerHTML = "";
  classes.forEach((c) => {
    const meeting = [c.meetingDay, c.meetingTime].filter(Boolean).join(" ") || "—";
    const groupLinkCell = c.whatsappGroupLink
      ? `<a href="${escapeAttr(c.whatsappGroupLink)}" target="_blank" rel="noopener"><button class="wa-btn" type="button">Open Group</button></a>
         <div style="font-size:11px;color:#888;margin-top:2px;">${formatUpdatedDate(c.whatsappGroupLinkUpdatedAt)}</div>`
      : "—";

    const inviteBtn = currentRole === "admin"
      ? `<button class="invite-teacher-btn" data-id="${c.id}" data-name="${escapeAttr(c.name)}" data-teacher-phone="${escapeAttr(c.teacherPhone || "")}" type="button">Invite Teacher</button>`
      : "";

    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${escapeHtml(c.name)}</td>
      <td>${escapeHtml(c.teacherName || "—")}</td>
      <td>${escapeHtml(meeting)}</td>
      <td>${groupLinkCell}</td>
      <td class="actions">
        <button class="edit-class-btn" data-id="${c.id}" type="button">Edit</button>
        ${inviteBtn}
      </td>`;
    tr.querySelector(".edit-class-btn").addEventListener("click", () => startEditClass(c.id));
    const inviteBtnEl = tr.querySelector(".invite-teacher-btn");
    if (inviteBtnEl) {
      inviteBtnEl.addEventListener("click", () =>
        generateLeaderInvite(inviteBtnEl.dataset.id, inviteBtnEl.dataset.name, inviteBtnEl.dataset.teacherPhone)
      );
    }
    tbody.appendChild(tr);
  });
}

window.startEditClass = function (classId) {
  const schoolClass = classesCache.find((c) => c.id === classId);
  if (!schoolClass) return;

  editingClassId = classId;
  document.getElementById("className").value = schoolClass.name || "";
  document.getElementById("classTeacher").value = schoolClass.teacherName || "";
  document.getElementById("classTeacherPhone").value = schoolClass.teacherPhone || "";
  document.getElementById("classDay").value = schoolClass.meetingDay || "";
  document.getElementById("classTime").value = schoolClass.meetingTime || "";
  document.getElementById("classGroupLink").value = schoolClass.whatsappGroupLink || "";

  document.getElementById("classFormTitle").textContent = `Edit Class: ${schoolClass.name}`;
  document.getElementById("classSubmitBtn").textContent = "Update Class";
  document.getElementById("classCancelBtn").style.display = "inline-block";

  document.getElementById("className").scrollIntoView({ behavior: "smooth", block: "center" });
};

window.cancelEditClass = function () {
  editingClassId = null;
  document.getElementById("className").value = "";
  document.getElementById("classTeacher").value = "";
  document.getElementById("classTeacherPhone").value = "";
  document.getElementById("classDay").value = "";
  document.getElementById("classTime").value = "";
  document.getElementById("classGroupLink").value = "";

  document.getElementById("classFormTitle").textContent = "Add Class";
  document.getElementById("classSubmitBtn").textContent = "Add Class";
  document.getElementById("classCancelBtn").style.display = "none";
};

window.addClass = async function () {
  const name = document.getElementById("className").value.trim();
  const teacherName = document.getElementById("classTeacher").value.trim();
  const teacherPhone = document.getElementById("classTeacherPhone").value.trim();
  const meetingDay = document.getElementById("classDay").value.trim();
  const meetingTime = document.getElementById("classTime").value.trim();
  const whatsappGroupLink = document.getElementById("classGroupLink").value.trim();

  if (!name) {
    alert("Class name is required");
    return;
  }

  const payload = { name, teacherName, teacherPhone, meetingDay, meetingTime, whatsappGroupLink };

  try {
    if (editingClassId) {
      await api(`/classes/${editingClassId}`, {
        method: "PUT",
        body: JSON.stringify(payload),
      });
    } else {
      await api("/classes", {
        method: "POST",
        body: JSON.stringify(payload),
      });
    }
  } catch (err) {
    alert("Couldn't save class: " + err.message);
    return;
  }

  cancelEditClass(); // resets form + editingClassId back to add-mode
  await loadClasses();
  await loadParents();
};

// ---------- Broadcast (Level 3 — automated via WhatsApp Business API) ----------

window.sendBroadcast = async function () {
  const classId = document.getElementById("broadcastClass").value;
  const message = document.getElementById("broadcastMessage").value.trim();
  const statusEl = document.getElementById("broadcastStatus");

  if (!classId) {
    alert("Choose a class first");
    return;
  }
  if (!message) {
    alert("Enter a message");
    return;
  }

  statusEl.textContent = "Sending...";
  try {
    const result = await api(`/broadcast/class/${classId}`, {
      method: "POST",
      body: JSON.stringify({ message }),
    });
    statusEl.textContent = `Sent to ${result.sent} parent(s)${result.failed ? `, ${result.failed} failed` : ""}.`;
    document.getElementById("broadcastMessage").value = "";
  } catch (err) {
    statusEl.textContent = "Error: " + err.message;
  }
};

// ---------- Attendance ----------

window.loadAttendanceForm = async function () {
  const classId = document.getElementById("attendanceClass").value;
  const listEl = document.getElementById("attendanceList");
  const statusEl = document.getElementById("attendanceStatus");
  statusEl.textContent = "";
  listEl.innerHTML = "";
  document.getElementById("absenteesCard").style.display = "none";
  document.getElementById("insightsCard").style.display = "none";

  if (!classId) return;

  const classParents = parentsCache.filter((m) => m.classId === classId);
  if (classParents.length === 0) {
    listEl.innerHTML = "<p style='font-size:13px;color:#888;'>No parents in this class yet.</p>";
    return;
  }

  const date = document.getElementById("attendanceDate").value || new Date().toISOString().slice(0, 10);
  let existing = { records: {} };
  try {
    existing = await api(`/attendance/class/${classId}?date=${date}`);
  } catch (err) {
    // no existing record for this date is fine
  }

  classParents.forEach((m) => {
    const row = document.createElement("div");
    row.className = "attend-row";
    const checked = existing.records && existing.records[m.id] ? "checked" : "";
    row.innerHTML = `<label style="display:flex;align-items:center;width:100%;">
      <input type="checkbox" data-parent-id="${m.id}" ${checked}>
      <span>
        <strong>${escapeHtml(m.childName || "(no child name on file)")}</strong>
        <span style="color:var(--ink-soft);font-size:13px;"> — parent: ${escapeHtml(m.name)}</span>
      </span>
    </label>`;
    listEl.appendChild(row);
  });

  // If a record already exists for this date, show absentees right away too.
  if (existing.records && Object.keys(existing.records).length > 0) {
    renderAbsentees(classId, classParents, existing.records);
  }

  await loadAttendanceInsights(classId);
};

document.getElementById("attendanceDate").addEventListener("change", () => {
  if (document.getElementById("attendanceClass").value) window.loadAttendanceForm();
});

document.getElementById("parentSearchPhone").addEventListener("keydown", (e) => {
  if (e.key === "Enter") window.filterParents();
});

window.saveAttendance = async function () {
  const classId = document.getElementById("attendanceClass").value;
  const date = document.getElementById("attendanceDate").value;
  const statusEl = document.getElementById("attendanceStatus");

  if (!classId) {
    alert("Choose a class first");
    return;
  }

  const checkboxes = document.querySelectorAll("#attendanceList input[type='checkbox']");
  const records = Array.from(checkboxes).map((cb) => ({
    parentId: cb.dataset.parentId,
    present: cb.checked,
  }));

  if (records.length === 0) {
    statusEl.textContent = "No parents to record.";
    return;
  }

  statusEl.textContent = "Saving...";
  try {
    const result = await api(`/attendance/class/${classId}`, {
      method: "POST",
      body: JSON.stringify({ date, records }),
    });
    statusEl.textContent = `Saved: ${result.presentCount}/${result.totalMembers} present on ${result.date}.`;

    const recordsMap = {};
    records.forEach((r) => { recordsMap[r.parentId] = r.present; });
    const classParents = parentsCache.filter((m) => m.classId === classId);
    renderAbsentees(classId, classParents, recordsMap);
  } catch (err) {
    statusEl.textContent = "Error: " + err.message;
  }
};

// Admin/teacher dashboard feature: one row per absentee, each with its own
// "Notify Parent" click-to-chat button (Level 2 — teacher still taps Send).
// Opens a direct WhatsApp chat with that parent, prefilled with the absence
// notice - since it's a normal 1:1 WhatsApp thread, the parent can just
// reply in it to reach the teacher directly, no extra plumbing needed.
function renderAbsentees(classId, classParents, recordsMap) {
  const card = document.getElementById("absenteesCard");
  const listEl = document.getElementById("absenteesList");
  const schoolClass = classesCache.find((c) => c.id === classId);
  const date = document.getElementById("attendanceDate").value || new Date().toISOString().slice(0, 10);

  const absentees = classParents.filter((m) => recordsMap[m.id] === false);

  if (absentees.length === 0) {
    card.style.display = "block";
    listEl.innerHTML = "<p style='font-size:13px;color:#888;'>Nobody absent — full house.</p>";
    return;
  }

  card.style.display = "block";
  listEl.innerHTML = "";

  absentees.forEach((m) => {
    const childLabel = m.childName || "your child";
    const absenceText = `Good afternoon. This is to inform you that ${childLabel} was marked absent from ${schoolClass?.name || "class"} today, ${date}. If this is unexpected or your child is unwell, please reply to this message and let the class teacher know — we hope all is well.`;
    const waLink = buildClickToChatLink(m.whatsappNumber || m.phone, absenceText);
    const row = document.createElement("div");
    row.className = "absent-row";
    row.innerHTML = `
      <span><strong>${escapeHtml(m.childName || "(no child name on file)")}</strong> — parent: ${escapeHtml(m.name)}</span>
      <a href="${waLink}" target="_blank" rel="noopener"><button class="wa-btn" type="button">Notify Parent</button></a>`;
    listEl.appendChild(row);
  });
}

// Attendance Insights: recent meeting history + parents needing a check-in
// (flagged by the backend when their rate is below threshold).
async function loadAttendanceInsights(classId) {
  const card = document.getElementById("insightsCard");
  const historyTbody = document.getElementById("historyTable");
  const lowListEl = document.getElementById("lowAttendanceList");

  try {
    const [{ history }, { rates }] = await Promise.all([
      api(`/attendance/class/${classId}/history?limit=12`),
      api(`/attendance/class/${classId}/rates?limit=12&threshold=50`),
    ]);

    if (history.length === 0) {
      card.style.display = "none";
      return;
    }
    card.style.display = "block";

    historyTbody.innerHTML = "";
    history.forEach((h) => {
      const tr = document.createElement("tr");
      tr.innerHTML = `<td>${escapeHtml(h.date)}</td><td>${h.presentCount}/${h.totalMembers}</td>`;
      historyTbody.appendChild(tr);
    });

    const flagged = rates.filter((r) => r.lowAttendance);
    lowListEl.innerHTML = "";

    if (flagged.length === 0) {
      lowListEl.innerHTML = "<p style='font-size:13px;color:#888;'>No one flagged — attendance looks healthy.</p>";
      return;
    }

    const schoolClass = classesCache.find((c) => c.id === classId);
    const checkinText = `Hi, we've noticed you've missed a few ${schoolClass?.name || "class"} meetings lately. We hope you're doing well — please let us know if we can pray for you or support you in any way.`;

    flagged.forEach((r) => {
      const waLink = buildClickToChatLink(r.whatsappNumber || r.phone, checkinText);
      const row = document.createElement("div");
      row.className = "absent-row";
      row.innerHTML = `
        <span>${escapeHtml(r.name)} (${r.attended}/${r.total}, ${r.rate}%)</span>
        <a href="${waLink}" target="_blank" rel="noopener"><button class="wa-btn" type="button">Send Check-in</button></a>`;
      lowListEl.appendChild(row);
    });
  } catch (err) {
    card.style.display = "none";
    console.error("Attendance insights failed:", err.message);
  }
}

// ---------- Teacher self-service invites ----------

window.generateLeaderInvite = async function (classId, className, teacherPhone) {
  const statusEl = document.getElementById("teacherInviteStatus");
  statusEl.textContent = "Generating...";
  document.getElementById("teacherInviteCard").style.display = "block";

  try {
    const result = await api(`/classes/${classId}/invite`, { method: "POST" });
    const inviteUrl = `${window.location.origin}/teacher-signup.html?school=${encodeURIComponent(currentSchoolId)}&token=${encodeURIComponent(result.token)}`;

    document.getElementById("teacherInviteHint").textContent =
      `One-time link for ${className}'s teacher to set up their own account. Expires in 7 days, works once.`;
    document.getElementById("teacherInviteLink").value = inviteUrl;

    const waLinkEl = document.getElementById("teacherInviteWaLink");
    if (teacherPhone) {
      const message = `Hi! Please use this link to set up your Elimu Smart teacher login for ${className}: ${inviteUrl}`;
      waLinkEl.href = buildClickToChatLink(teacherPhone, message);
      waLinkEl.style.display = "inline-block";
    } else {
      waLinkEl.style.display = "none";
    }

    statusEl.textContent = "";
    document.getElementById("teacherInviteCard").scrollIntoView({ behavior: "smooth", block: "center" });
  } catch (err) {
    statusEl.textContent = "Error: " + err.message;
  }
};

window.copyTeacherInviteLink = function () {
  const input = document.getElementById("teacherInviteLink");
  input.select();
  navigator.clipboard.writeText(input.value).then(() => {
    document.getElementById("teacherInviteStatus").textContent = "Copied!";
  }).catch(() => {
    document.getElementById("teacherInviteStatus").textContent = "Copy failed - select and copy manually.";
  });
};

// ---------- Lesson Plans ----------

let lessonPlansCache = [];
let editingLessonPlanId = null;

// Textareas hold one item per line; the backend stores these as arrays.
function linesToArray(text) {
  return (text || "").split("\n").map((s) => s.trim()).filter(Boolean);
}
function arrayToLines(arr) {
  return (arr || []).join("\n");
}

async function loadMyLessonPlans() {
  const { lessonPlans } = await api("/lesson-plans");
  lessonPlansCache = lessonPlans;
  renderMyLessonPlansTable(lessonPlansCache);
}

function renderMyLessonPlansTable(list) {
  const tbody = document.getElementById("myLessonPlansTable");
  tbody.innerHTML = "";

  if (!list.length) {
    tbody.innerHTML = "<tr><td colspan='5'>No lesson plans yet.</td></tr>";
    return;
  }

  list.forEach((lp) => {
    const tr = document.createElement("tr");
    const termWeek = escapeHtml(lp.term || "") + (lp.week ? " / Wk " + escapeHtml(String(lp.week)) : "");
    const canEdit = lp.status === "draft";
    tr.innerHTML = `
      <td>${termWeek}</td>
      <td>${escapeHtml(lp.subject || "")}</td>
      <td>${escapeHtml(lp.strand || "—")}</td>
      <td>${escapeHtml(lp.status)}</td>
      <td>
        ${canEdit ? `<button class="edit-lesson-plan-btn" data-id="${lp.id}">Edit</button>` : ""}
        ${canEdit ? `<button class="submit-lesson-plan-btn" data-id="${lp.id}">Submit</button>` : ""}
        <button class="print-lesson-plan-btn" data-id="${lp.id}">Print</button>
        ${canEdit ? `<button class="delete-lesson-plan-btn" data-id="${lp.id}" style="background:#a33;">Delete</button>` : ""}
      </td>`;
    tbody.appendChild(tr);
  });

  tbody.querySelectorAll(".edit-lesson-plan-btn").forEach((btn) => {
    btn.addEventListener("click", () => startEditLessonPlan(btn.dataset.id));
  });
  tbody.querySelectorAll(".submit-lesson-plan-btn").forEach((btn) => {
    btn.addEventListener("click", () => submitLessonPlan(btn.dataset.id));
  });
  tbody.querySelectorAll(".print-lesson-plan-btn").forEach((btn) => {
    btn.addEventListener("click", () => printLessonPlan(btn.dataset.id, lessonPlansCache));
  });
  tbody.querySelectorAll(".delete-lesson-plan-btn").forEach((btn) => {
    btn.addEventListener("click", () => deleteLessonPlan(btn.dataset.id));
  });
}

function startEditLessonPlan(id) {
  const lp = lessonPlansCache.find((p) => p.id === id);
  if (!lp) return;

  editingLessonPlanId = id;
  document.getElementById("lpTerm").value = lp.term || "";
  document.getElementById("lpWeek").value = lp.week || "";
  document.getElementById("lpDate").value = lp.date || "";
  document.getElementById("lpSubject").value = lp.subject || "";
  document.getElementById("lpStrand").value = lp.strand || "";
  document.getElementById("lpSubStrand").value = lp.subStrand || "";
  document.getElementById("lpObjectives").value = arrayToLines(lp.objectives);
  document.getElementById("lpActivities").value = arrayToLines(lp.lessonActivities);
  document.getElementById("lpResources").value = arrayToLines(lp.resources);
  document.getElementById("lpAssessment").value = lp.assessmentMethod || "";

  document.getElementById("lessonPlanFormTitle").textContent = "Edit Lesson Plan";
  document.getElementById("lpCancelBtn").style.display = "inline-block";
  document.getElementById("addLessonPlanCard").scrollIntoView({ behavior: "smooth" });
}

window.cancelEditLessonPlan = function () {
  editingLessonPlanId = null;
  ["lpTerm", "lpWeek", "lpDate", "lpSubject", "lpStrand", "lpSubStrand",
   "lpObjectives", "lpActivities", "lpResources", "lpAssessment"].forEach((id) => {
    document.getElementById(id).value = "";
  });
  document.getElementById("lessonPlanFormTitle").textContent = "New Lesson Plan";
  document.getElementById("lpCancelBtn").style.display = "none";
};

window.saveLessonPlan = async function () {
  const statusEl = document.getElementById("lessonPlanStatus");
  statusEl.textContent = "";

  const term = document.getElementById("lpTerm").value.trim();
  const subject = document.getElementById("lpSubject").value.trim();
  if (!term || !subject) {
    statusEl.textContent = "Term and subject are required.";
    return;
  }

  const payload = {
    classId: currentClassId,
    term,
    week: document.getElementById("lpWeek").value.trim() || null,
    date: document.getElementById("lpDate").value || null,
    subject,
    strand: document.getElementById("lpStrand").value.trim(),
    subStrand: document.getElementById("lpSubStrand").value.trim(),
    objectives: linesToArray(document.getElementById("lpObjectives").value),
    lessonActivities: linesToArray(document.getElementById("lpActivities").value),
    resources: linesToArray(document.getElementById("lpResources").value),
    assessmentMethod: document.getElementById("lpAssessment").value.trim(),
  };

  try {
    if (editingLessonPlanId) {
      await api(`/lesson-plans/${editingLessonPlanId}`, { method: "PUT", body: JSON.stringify(payload) });
    } else {
      await api("/lesson-plans", { method: "POST", body: JSON.stringify(payload) });
    }
    window.cancelEditLessonPlan();
    await loadMyLessonPlans();
    statusEl.textContent = "Saved.";
  } catch (err) {
    statusEl.textContent = "Couldn't save lesson plan: " + err.message;
  }
};

async function submitLessonPlan(id) {
  const statusEl = document.getElementById("lessonPlanStatus");
  try {
    await api(`/lesson-plans/${id}/submit`, { method: "POST" });
    await loadMyLessonPlans();
    statusEl.textContent = "Submitted for approval.";
  } catch (err) {
    statusEl.textContent = "Couldn't submit: " + err.message;
  }
}

async function deleteLessonPlan(id) {
  if (!confirm("Delete this draft lesson plan?")) return;
  try {
    await api(`/lesson-plans/${id}`, { method: "DELETE" });
    await loadMyLessonPlans();
  } catch (err) {
    document.getElementById("lessonPlanStatus").textContent = "Couldn't delete: " + err.message;
  }
}

// ---------- Lesson Plan Review (admin) ----------

window.loadLessonPlanReviewQueue = async function () {
  const status = document.getElementById("lpReviewFilter").value;
  const query = status ? `?status=${encodeURIComponent(status)}` : "";
  const { lessonPlans } = await api(`/lesson-plans${query}`);
  renderLessonPlanReviewTable(lessonPlans);
};

function renderLessonPlanReviewTable(list) {
  const tbody = document.getElementById("lessonPlanReviewTable");
  tbody.innerHTML = "";

  if (!list.length) {
    tbody.innerHTML = "<tr><td colspan='6'>Nothing here.</td></tr>";
    return;
  }

  list.forEach((lp) => {
    const cls = classesCache.find((c) => c.id === lp.classId);
    const termWeek = escapeHtml(lp.term || "") + (lp.week ? " / Wk " + escapeHtml(String(lp.week)) : "");
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${escapeHtml(cls ? cls.name : lp.classId)}</td>
      <td>${termWeek}</td>
      <td>${escapeHtml(lp.subject || "")}</td>
      <td>${escapeHtml(lp.teacherId)}</td>
      <td>${escapeHtml(lp.status)}</td>
      <td>
        ${lp.status === "submitted" ? `<button class="approve-lesson-plan-btn" data-id="${lp.id}">Approve</button>` : ""}
        ${lp.status === "submitted" || lp.status === "approved" ? `<button class="reject-lesson-plan-btn" data-id="${lp.id}" style="background:#888;">Back to Draft</button>` : ""}
        <button class="print-lesson-plan-btn" data-id="${lp.id}">Print</button>
      </td>`;
    tbody.appendChild(tr);
  });

  tbody.querySelectorAll(".approve-lesson-plan-btn").forEach((btn) => {
    btn.addEventListener("click", () => reviewLessonPlan(btn.dataset.id, "approved"));
  });
  tbody.querySelectorAll(".reject-lesson-plan-btn").forEach((btn) => {
    btn.addEventListener("click", () => reviewLessonPlan(btn.dataset.id, "draft"));
  });
  tbody.querySelectorAll(".print-lesson-plan-btn").forEach((btn) => {
    btn.addEventListener("click", () => printLessonPlan(btn.dataset.id, list));
  });
}

async function reviewLessonPlan(id, newStatus) {
  let reviewNote = "";
  if (newStatus === "draft") {
    reviewNote = prompt("Optional note for the teacher on why this was sent back:") || "";
  }
  try {
    await api(`/lesson-plans/${id}`, { method: "PUT", body: JSON.stringify({ status: newStatus, reviewNote }) });
    await window.loadLessonPlanReviewQueue();
  } catch (err) {
    alert("Couldn't update lesson plan: " + err.message);
  }
}

// ---------- Homework (AI/OCR) ----------

let homeworkCache = [];
let editingHomeworkId = null;
let lastScannedImageBase64 = null; // kept so the published record can store the original photo
let lastScannedImageMediaType = null;

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      // reader.result is "data:image/jpeg;base64,AAAA..." - strip the prefix
      const base64 = reader.result.split(",")[1];
      resolve(base64);
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

async function loadApprovedLessonPlansForHomework() {
  const { lessonPlans } = await api("/lesson-plans");
  const approved = lessonPlans.filter((lp) => lp.status === "approved");
  const select = document.getElementById("hwLessonPlan");
  select.innerHTML = '<option value="">-- Choose an approved lesson plan --</option>';
  approved.forEach((lp) => {
    const opt = document.createElement("option");
    opt.value = lp.id;
    opt.textContent = `${lp.term || ""}${lp.week ? " Wk " + lp.week : ""} - ${lp.subject || ""}${lp.subStrand ? " (" + lp.subStrand + ")" : ""}`;
    select.appendChild(opt);
  });
  if (!approved.length) {
    select.innerHTML = '<option value="">-- No approved lesson plans yet --</option>';
  }
}

window.scanHomeworkPhoto = async function () {
  const statusEl = document.getElementById("hwScanStatus");
  const fileInput = document.getElementById("hwPhotoInput");
  const file = fileInput.files[0];

  if (!file) {
    statusEl.textContent = "Choose or take a photo first.";
    return;
  }

  statusEl.textContent = "Scanning...";
  try {
    const base64 = await fileToBase64(file);
    lastScannedImageBase64 = base64;
    lastScannedImageMediaType = file.type || "image/jpeg";
    const result = await api("/homework/ocr", {
      method: "POST",
      body: JSON.stringify({ imageBase64: base64, mediaType: lastScannedImageMediaType }),
    });

    document.getElementById("hwRawText").value = result.text;
    document.getElementById("hwRawText").style.display = "block";
    document.getElementById("hwStructureBtn").style.display = "inline-block";
    statusEl.textContent = result.text.includes("[unclear]")
      ? "Scanned - check the [unclear] spots below before continuing."
      : "Scanned. Review the text, then tap \"Fill In Details From This Text\".";
  } catch (err) {
    // A 422 from the backend means low confidence - the message already
    // explains it's a retake-photo situation, so just show it as-is.
    lastScannedImageBase64 = null;
    lastScannedImageMediaType = null;
    statusEl.textContent = err.message;
  }
};

window.structureHomeworkNote = async function () {
  const statusEl = document.getElementById("hwScanStatus");
  const rawText = document.getElementById("hwRawText").value.trim();
  if (!rawText) {
    statusEl.textContent = "Nothing to structure yet.";
    return;
  }

  statusEl.textContent = "Filling in details...";
  try {
    const structured = await api("/homework/structure", { method: "POST", body: JSON.stringify({ rawText }) });
    document.getElementById("hwSubject").value = structured.subject;
    document.getElementById("hwInstructions").value = structured.instructions;
    document.getElementById("hwDueDate").value = structured.dueDate;
    document.getElementById("hwMaterials").value = arrayToLines(structured.materials);
    statusEl.textContent = "Details filled in below - review and edit before saving.";
  } catch (err) {
    statusEl.textContent = "Couldn't fill in details: " + err.message;
  }
};

async function loadMyHomework() {
  const { homework } = await api("/homework");
  homeworkCache = homework;
  renderMyHomeworkTable(homeworkCache);
}

function renderMyHomeworkTable(list) {
  const tbody = document.getElementById("myHomeworkTable");
  tbody.innerHTML = "";

  if (!list.length) {
    tbody.innerHTML = "<tr><td colspan='4'>No homework yet.</td></tr>";
    return;
  }

  list.forEach((hw) => {
    const canEdit = hw.status === "draft";
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${escapeHtml(hw.subject || "")}</td>
      <td>${escapeHtml(hw.dueDate || "—")}</td>
      <td>${escapeHtml(hw.status)}</td>
      <td>
        ${canEdit ? `<button class="edit-homework-btn" data-id="${hw.id}">Edit</button>` : ""}
        ${canEdit ? `<button class="publish-homework-btn" data-id="${hw.id}">Publish</button>` : ""}
        <button class="print-homework-btn" data-id="${hw.id}">Print</button>
        ${canEdit ? `<button class="delete-homework-btn" data-id="${hw.id}" style="background:#a33;">Delete</button>` : ""}
      </td>`;
    tbody.appendChild(tr);
  });

  tbody.querySelectorAll(".edit-homework-btn").forEach((btn) => {
    btn.addEventListener("click", () => startEditHomework(btn.dataset.id));
  });
  tbody.querySelectorAll(".publish-homework-btn").forEach((btn) => {
    btn.addEventListener("click", () => publishHomework(btn.dataset.id));
  });
  tbody.querySelectorAll(".print-homework-btn").forEach((btn) => {
    btn.addEventListener("click", () => printHomework(btn.dataset.id, list));
  });
  tbody.querySelectorAll(".delete-homework-btn").forEach((btn) => {
    btn.addEventListener("click", () => deleteHomework(btn.dataset.id));
  });
}

function startEditHomework(id) {
  const hw = homeworkCache.find((h) => h.id === id);
  if (!hw) return;

  editingHomeworkId = id;
  document.getElementById("hwLessonPlan").value = hw.lessonPlanId || "";
  document.getElementById("hwSubject").value = hw.subject || "";
  document.getElementById("hwInstructions").value = hw.instructions || "";
  document.getElementById("hwDueDate").value = hw.dueDate || "";
  document.getElementById("hwMaterials").value = arrayToLines(hw.materials);

  document.getElementById("homeworkFormTitle").textContent = "Edit Homework";
  document.getElementById("hwCancelBtn").style.display = "inline-block";
  document.getElementById("addHomeworkCard").scrollIntoView({ behavior: "smooth" });
}

window.cancelEditHomework = function () {
  editingHomeworkId = null;
  lastScannedImageBase64 = null;
  lastScannedImageMediaType = null;
  document.getElementById("hwLessonPlan").value = "";
  document.getElementById("hwPhotoInput").value = "";
  document.getElementById("hwRawText").value = "";
  document.getElementById("hwRawText").style.display = "none";
  document.getElementById("hwStructureBtn").style.display = "none";
  document.getElementById("hwSubject").value = "";
  document.getElementById("hwInstructions").value = "";
  document.getElementById("hwDueDate").value = "";
  document.getElementById("hwMaterials").value = "";
  document.getElementById("hwScanStatus").textContent = "";
  document.getElementById("homeworkFormTitle").textContent = "New Homework";
  document.getElementById("hwCancelBtn").style.display = "none";
};

window.saveHomework = async function () {
  const statusEl = document.getElementById("homeworkStatus");
  statusEl.textContent = "";

  const lessonPlanId = document.getElementById("hwLessonPlan").value;
  const instructions = document.getElementById("hwInstructions").value.trim();

  if (!editingHomeworkId && !lessonPlanId) {
    statusEl.textContent = "Choose an approved lesson plan first.";
    return;
  }
  if (!instructions) {
    statusEl.textContent = "Instructions are required.";
    return;
  }

  const payload = {
    classId: currentClassId,
    lessonPlanId,
    subject: document.getElementById("hwSubject").value.trim(),
    instructions,
    dueDate: document.getElementById("hwDueDate").value || null,
    materials: linesToArray(document.getElementById("hwMaterials").value),
    sourceType: lastScannedImageBase64 ? "ocr" : "manual",
    originalImageBase64: lastScannedImageBase64,
    originalImageMediaType: lastScannedImageMediaType,
  };

  try {
    if (editingHomeworkId) {
      await api(`/homework/${editingHomeworkId}`, { method: "PUT", body: JSON.stringify(payload) });
    } else {
      await api("/homework", { method: "POST", body: JSON.stringify(payload) });
    }
    window.cancelEditHomework();
    await loadMyHomework();
    statusEl.textContent = "Saved.";
  } catch (err) {
    statusEl.textContent = "Couldn't save homework: " + err.message;
  }
};

async function publishHomework(id) {
  if (!confirm("Publish this homework? Once published you can't edit or delete it.")) return;
  const statusEl = document.getElementById("homeworkStatus");
  try {
    const result = await api(`/homework/${id}/publish`, { method: "POST" });
    await loadMyHomework();
    renderHomeworkSendLinks(result.parents);
    statusEl.textContent = "Published. Tap Send below for each parent to deliver it on WhatsApp.";
  } catch (err) {
    statusEl.textContent = "Couldn't publish: " + err.message;
  }
}

function renderHomeworkSendLinks(parents) {
  const container = document.getElementById("homeworkSendLinks");
  if (!container) return;
  if (!parents || !parents.length) {
    container.innerHTML = "<p style='font-size:13px;color:#888;'>No parents with a phone number on file for this class.</p>";
    return;
  }
  container.innerHTML = parents.map((p) => `
    <div class="absent-row">
      <span><strong>${escapeHtml(p.childName || "(no child name)")}</strong> — parent: ${escapeHtml(p.name)}</span>
      <a href="${p.waLink}" target="_blank" rel="noopener"><button class="wa-btn" type="button">Send</button></a>
    </div>`).join("");
}

async function deleteHomework(id) {
  if (!confirm("Delete this draft homework?")) return;
  try {
    await api(`/homework/${id}`, { method: "DELETE" });
    await loadMyHomework();
  } catch (err) {
    document.getElementById("homeworkStatus").textContent = "Couldn't delete: " + err.message;
  }
}

// ---------- Analytics ----------

function populateAnalyticsClassSelect() {
  const select = document.getElementById("analyticsClass");
  select.innerHTML = '<option value="">-- Choose a Class --</option>';

  const options = currentRole === "teacher"
    ? classesCache.filter((c) => c.id === currentClassId)
    : classesCache;

  options.forEach((c) => {
    const opt = document.createElement("option");
    opt.value = c.id;
    opt.textContent = c.name;
    select.appendChild(opt);
  });

  // Teachers only ever have one class - preselect and load it immediately.
  if (currentRole === "teacher" && options.length) {
    select.value = options[0].id;
    window.loadClassAnalytics();
  }
}

window.loadClassAnalytics = async function () {
  const classId = document.getElementById("analyticsClass").value;
  const subStrandBody = document.getElementById("analyticsSubStrandTable");
  const subjectBody = document.getElementById("analyticsSubjectTable");

  if (!classId) {
    subStrandBody.innerHTML = "";
    subjectBody.innerHTML = "";
    return;
  }

  const term = document.getElementById("analyticsTerm").value.trim();
  const query = term ? `?term=${encodeURIComponent(term)}` : "";

  try {
    const data = await api(`/analytics/class/${classId}${query}`);

    subStrandBody.innerHTML = data.bySubStrand.length
      ? data.bySubStrand.map((row) => `
          <tr>
            <td>${escapeHtml(row.subject || "—")}</td>
            <td>${escapeHtml(row.subStrand)}</td>
            <td>${row.homeworkCount}</td>
            <td>${row.publishedCount}</td>
          </tr>`).join("")
      : "<tr><td colspan='4'>No homework data yet for this class.</td></tr>";

    subjectBody.innerHTML = data.bySubject.length
      ? data.bySubject.map((row) => `
          <tr>
            <td>${escapeHtml(row.subject || "—")}</td>
            <td>${row.homeworkCount}</td>
            <td>${row.subStrandsCovered}</td>
          </tr>`).join("")
      : "<tr><td colspan='3'>No homework data yet for this class.</td></tr>";
  } catch (err) {
    subStrandBody.innerHTML = `<tr><td colspan='4'>Couldn't load analytics: ${escapeHtml(err.message)}</td></tr>`;
    subjectBody.innerHTML = "";
  }
};

// ---------- Print ----------
//
// Shared print utility, as designed for [[elimu]]: one print/export path
// reused by lesson plans and homework rather than building separate PDF
// generation per feature. Uses the browser's native print (a new window
// styled for print, then window.print()) rather than a PDF library - no
// new backend dependency, and it lets the parent's own printer/print-to-PDF
// handle paper size and margins correctly.

function openPrintWindow(title, bodyHtml) {
  const printWindow = window.open("", "_blank", "width=800,height=900");
  if (!printWindow) {
    alert("Please allow pop-ups for this site to use Print.");
    return;
  }

  printWindow.document.write(`<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>${escapeHtml(title)}</title>
<style>
  body { font-family: 'Georgia', serif; color: #2b2b2b; max-width: 700px; margin: 32px auto; line-height: 1.5; }
  h1 { font-size: 22px; border-bottom: 2px solid #2b2b2b; padding-bottom: 8px; }
  h2 { font-size: 15px; margin-top: 22px; margin-bottom: 4px; text-transform: uppercase; letter-spacing: 0.5px; color: #555; }
  .meta { font-size: 13px; color: #555; margin-bottom: 16px; }
  ul { margin: 4px 0; padding-left: 20px; }
  .empty { color: #888; font-style: italic; }
  @media print {
    .no-print { display: none; }
  }
</style>
</head>
<body>
  <button class="no-print" onclick="window.print()" style="margin-bottom:16px;">Print / Save as PDF</button>
  ${bodyHtml}
</body>
</html>`);
  printWindow.document.close();
}

function printListOrEmpty(items) {
  if (!items || !items.length) return '<p class="empty">None listed</p>';
  return '<ul>' + items.map((item) => `<li>${escapeHtml(item)}</li>`).join('') + '</ul>';
}

// Prints the current on-screen roll call (whatever's checked/unchecked right
// now in #attendanceList) with clear Present/Absent marking per child.
window.printAttendance = function () {
  const classId = document.getElementById("attendanceClass").value;
  if (!classId) {
    alert("Choose a class first.");
    return;
  }

  const schoolClass = classesCache.find((c) => c.id === classId);
  const date = document.getElementById("attendanceDate").value || new Date().toISOString().slice(0, 10);
  const checkboxes = document.querySelectorAll("#attendanceList input[type='checkbox']");

  const rows = Array.from(checkboxes).map((cb) => {
    const parent = parentsCache.find((p) => p.id === cb.dataset.parentId);
    return {
      childName: parent?.childName || "(no child name on file)",
      parentName: parent?.name || "",
      present: cb.checked,
    };
  });

  if (rows.length === 0) {
    alert("No roll call to print for this class yet.");
    return;
  }

  const presentCount = rows.filter((r) => r.present).length;

  const bodyHtml = `
    <h1>${escapeHtml(schoolClass ? schoolClass.name : "Class")} — Attendance</h1>
    <div class="meta">${escapeHtml(date)} &middot; ${presentCount}/${rows.length} present</div>
    <table style="width:100%;border-collapse:collapse;margin-top:12px;">
      <thead>
        <tr style="border-bottom:2px solid #2b2b2b;">
          <th style="text-align:left;padding:6px 4px;">Child</th>
          <th style="text-align:left;padding:6px 4px;">Parent</th>
          <th style="text-align:left;padding:6px 4px;">Status</th>
        </tr>
      </thead>
      <tbody>
        ${rows.map((r) => `
          <tr style="border-bottom:1px solid #ddd;">
            <td style="padding:6px 4px;">${escapeHtml(r.childName)}</td>
            <td style="padding:6px 4px;">${escapeHtml(r.parentName)}</td>
            <td style="padding:6px 4px;font-weight:700;color:${r.present ? '#2F5A3D' : '#7E362C'};">
              ${r.present ? 'PRESENT' : 'ABSENT'}
            </td>
          </tr>`).join('')}
      </tbody>
    </table>
  `;

  openPrintWindow(`Attendance — ${schoolClass ? schoolClass.name : "Class"} — ${date}`, bodyHtml);
};

function printLessonPlan(id, list) {
  const lp = list.find((p) => p.id === id);
  if (!lp) return;

  const cls = classesCache.find((c) => c.id === lp.classId);
  const title = `Lesson Plan - ${lp.subject || ""} - ${lp.term || ""}`;

  const bodyHtml = `
    <h1>${escapeHtml(lp.subject || "Lesson Plan")}</h1>
    <div class="meta">
      ${escapeHtml(cls ? cls.name : "")} &middot;
      ${escapeHtml(lp.term || "")}${lp.week ? " &middot; Week " + escapeHtml(String(lp.week)) : ""}${lp.date ? " &middot; " + escapeHtml(lp.date) : ""}
    </div>
    <h2>Strand / Sub-strand</h2>
    <p>${escapeHtml(lp.strand || "—")}${lp.subStrand ? " / " + escapeHtml(lp.subStrand) : ""}</p>
    <h2>Learning Objectives</h2>
    ${printListOrEmpty(lp.objectives)}
    <h2>Key Inquiry Questions</h2>
    ${printListOrEmpty(lp.keyInquiryQuestions)}
    <h2>Lesson Activities</h2>
    ${printListOrEmpty(lp.lessonActivities)}
    <h2>Resources</h2>
    ${printListOrEmpty(lp.resources)}
    <h2>Assessment Method</h2>
    <p>${lp.assessmentMethod ? escapeHtml(lp.assessmentMethod) : '<span class="empty">Not specified</span>'}</p>
  `;

  openPrintWindow(title, bodyHtml);
}

function printHomework(id, list) {
  const hw = list.find((h) => h.id === id);
  if (!hw) return;

  const cls = classesCache.find((c) => c.id === hw.classId);
  const title = `Homework - ${hw.subject || ""}`;

  const bodyHtml = `
    <h1>${escapeHtml(hw.subject || "Homework")}</h1>
    <div class="meta">
      ${escapeHtml(cls ? cls.name : "")}${hw.dueDate ? " &middot; Due " + escapeHtml(hw.dueDate) : ""}
    </div>
    <h2>Instructions</h2>
    <p>${escapeHtml(hw.instructions || "")}</p>
    <h2>Materials Needed</h2>
    ${printListOrEmpty(hw.materials)}
  `;

  openPrintWindow(title, bodyHtml);
}

// ---------- Utils ----------

function formatUpdatedDate(ts) {
  if (!ts) return "Link date unknown";
  // Firestore Timestamps serialize over JSON as {_seconds, _nanoseconds} or {seconds, nanoseconds}
  const seconds = ts._seconds ?? ts.seconds;
  if (seconds === undefined) return "Link date unknown";
  const date = new Date(seconds * 1000);
  return "Updated " + date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str ?? "";
  return div.innerHTML;
}

function escapeAttr(str) {
  return (str ?? "").replace(/"/g, "&quot;");
}
