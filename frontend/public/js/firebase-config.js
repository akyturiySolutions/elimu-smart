import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";

// Your web app's Firebase configuration
const firebaseConfig = {
  apiKey: "AIzaSyAFUrw0fKb9pty1CPHHnqRP_DcUYwZv5Fc",
  authDomain: "elimu-smart-76f23.firebaseapp.com",
  projectId: "elimu-smart-76f23",
  storageBucket: "elimu-smart-76f23.firebasestorage.app",
  messagingSenderId: "912913419678",
  appId: "1:912913419678:web:749715221ffe839b509a8f"
};

export const firebaseApp = initializeApp(firebaseConfig);
export const auth = getAuth(firebaseApp);

//export const API_BASE = "http://localhost:3000/api";
export const API_BASE = "https://https://elimu-smart-2i5q.onrender.com/api"; 