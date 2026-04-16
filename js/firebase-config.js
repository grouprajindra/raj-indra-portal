/* =============================================
   Firebase Configuration — Raj Indra Professional
   =============================================
   
   SETUP INSTRUCTIONS:
   1. Go to https://console.firebase.google.com
   2. Click "Create a project" (or "Add project")
   3. Enter project name: "raj-indra-portal" → Continue
   4. Disable Google Analytics (optional) → Create Project
   5. Once created, click the Web icon (</>) to add a web app
   6. Enter app name: "Raj Indra Portal" → Register app
   7. Copy the firebaseConfig object and REPLACE the placeholder below
   8. Then go to Firestore Database → Create Database → Start in TEST MODE → Done
   
   IMPORTANT: Replace the placeholder values below with YOUR Firebase config!
*/

const firebaseConfig = {
    apiKey: "PASTE_YOUR_API_KEY_HERE",
    authDomain: "PASTE_YOUR_PROJECT.firebaseapp.com",
    projectId: "PASTE_YOUR_PROJECT_ID_HERE",
    storageBucket: "PASTE_YOUR_PROJECT.appspot.com",
    messagingSenderId: "PASTE_YOUR_SENDER_ID",
    appId: "PASTE_YOUR_APP_ID_HERE"
};

// ===== DO NOT MODIFY BELOW THIS LINE =====

// Initialize Firebase only if config is filled in
if (firebaseConfig.apiKey && firebaseConfig.apiKey !== 'PASTE_YOUR_API_KEY_HERE') {
    try {
        firebase.initializeApp(firebaseConfig);
        console.log('🔥 Firebase initialized successfully');
    } catch(e) {
        console.warn('Firebase init error:', e.message);
    }
} else {
    console.log('ℹ️ Firebase not configured. Portal will use local storage only.');
    console.log('ℹ️ To enable cloud sync, edit js/firebase-config.js with your Firebase credentials.');
}
