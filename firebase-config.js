// Firebase's web API key identifies the Firebase project; it is not an admin secret.
// Authorization is enforced by Firebase Authentication and Firestore rules.
export const firebaseConfig = {
  apiKey: "AIzaSyB-v318rSfkFbNEJelIKUpUnUSsgQwrtGE",
  authDomain: "reel-it-df4ff.firebaseapp.com",
  projectId: "reel-it-df4ff",
  storageBucket: "reel-it-df4ff.firebasestorage.app",
  messagingSenderId: "505436045173",
  appId: "1:505436045173:web:2d59f7b6c045cc86669d3c"
};

export const functionsRegion = "asia-south1";

// Required because Reel It callable functions enforce Firebase App Check.
// Create a reCAPTCHA v3 provider in Firebase Console → App Check → Web app,
// then paste the public site key here. It is safe to commit this public key.
export const recaptchaSiteKey = "";
