import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";

const firebaseConfig = {
  apiKey: "AIzaSyA755FXWq9I-IDgu6rN4q7HRVsLEbvFCbg",
  authDomain: "elimu-smart-prod.firebaseapp.com",
  projectId: "elimu-smart-prod",
  storageBucket: "elimu-smart-prod.firebasestorage.app",
  messagingSenderId: "389820776174",
  appId: "1:389820776174:web:edbf493926eff1fef37dff",
};

export const firebaseApp = initializeApp(firebaseConfig);
export const auth = getAuth(firebaseApp);

export const API_BASE = "https://elimu-smart.onrender.com/api";