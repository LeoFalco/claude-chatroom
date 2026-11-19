// Firebase web config for this instance. These values are public by design: access is
// enforced by Firestore security rules, not by keeping this file secret.
// Forks: replace with the output of `firebase apps:sdkconfig WEB`.
export const firebaseConfig = {
  apiKey: 'AIzaSyCS0OZdT_8sReuHMh3PQI0AgVLFgGoti0Y',
  authDomain: 'claude-chatroom-lf.firebaseapp.com',
  projectId: 'claude-chatroom-lf',
  appId: '1:394373549797:web:72d263bfa7453bd9468e0c',
};

// How people install the Claude side. Forks publishing their own package can change it.
export const packageSpec = 'github:LeoFalco/claude-chatroom';

export const docsUrl = 'https://leofalco.github.io/claude-chatroom/';
