// ─────────────────────────────────────────────────────────────
//  Everything you might want to change lives in this one file.
//  Nothing here is a secret: Firebase web config is meant to be
//  public. Security comes from the Firestore rules and the API
//  function, not from hiding these values.
// ─────────────────────────────────────────────────────────────

const MERRITT = {
  babyName: "Merritt",
  nickname: "Mer",           // used in friendly lines like "What Mer is loving these days"
  // Who gifters are thanking (shown when they add their name to a claim).
  ownerName: "Lys",

  // Shows the editing controls when this Google account signs in.
  // (Display only: the API function and Firestore rules do the real check.)
  ownerEmail: "alyssamanse@gmail.com",

  // Firestore document id for this wishlist. Random so it can't be
  // guessed, but the rules don't rely on that. Must match the API
  // function's WISHLIST_ID setting.
  wishlistId: "w_f6Un6k7se0dvifVErHRe",

  // URL of the `api` function (README step 5). Until it's set, the
  // site is view-only.
  apiUrl: "https://closet-api-767635696368.us-central1.run.app",

  // reCAPTCHA Enterprise site key for App Check (README step 6).
  // Empty = App Check off (fine while testing).
  appCheckSiteKey: "",

  // "Shopping for the rest of the family?" page: one wishlist section per person.
  family: ["Lys", "Michael", "Penny"],

  // Starter "Her colors" swatches (edit them on the Sizes page once signed in).
  palette: [
    { name: "Dusty rose", hex: "#D4AEAA" },
    { name: "Blush", hex: "#EBD6D3" },
    { name: "Oat", hex: "#F6F0E7" },
    { name: "Beige", hex: "#E3D5C2" },
    { name: "Sage", hex: "#A7B8A0" },
    { name: "Deep sage", hex: "#5F7A5E" },
  ],

  // Merritt's Closet Firebase project (separate from Starting Solids).
  firebase: {
    apiKey: "AIzaSyBPvp5L3PdwhONzimWPYzoPiW_vs5ob5Hc",
    authDomain: "merrittscloset-4d74f.firebaseapp.com",
    projectId: "merrittscloset-4d74f",
    storageBucket: "merrittscloset-4d74f.firebasestorage.app",
    messagingSenderId: "767635696368",
    appId: "1:767635696368:web:00654bf18eda920b077035",
  },
};

// ─────────────────────────────────────────────────────────────
//  Other wishlists served by the same app (one codebase, separate data,
//  separate server copy). A site is picked by the page that loads it:
//  /MerrittsCloset/luca/ sets window.CLOSET_SITE = "luca".
// ─────────────────────────────────────────────────────────────
const SITES = {
  luca: {
    babyName: "Luca",
    nickname: "",
    ownerName: "his family",                       // "Only <ownerName> can see who's waiting"
    ownerEmail: "",                                // TODO: Luca's mom's Google account (display only)
    wishlistId: "w_8nq00X41XkIsTMvl5GJT",
    apiUrl: "https://luca-api-767635696368.us-central1.run.app",
    appCheckSiteKey: "",
    siteUrl: "https://alyssamanse.github.io/MerrittsCloset/luca/",
    title: "Luca's Wishlist",
    logoSub: "Wishlist",
    tagline: "Gift ideas for Luca, and a way to make sure nobody doubles up",
    tabs: ["wishlist"],                            // wishlist only: no closet, sizes or family pages
    family: [],
    pronoun: { her: "his", she: "he" },
    monogram: "L",
    crestIcon: "boat",
    palette: [],
    firebase: MERRITT.firebase,                   // same Firebase project
  },
};

const siteKey = (typeof window !== "undefined" && window.CLOSET_SITE) || "";
export const CONFIG = SITES[siteKey] ? { ...MERRITT, ...SITES[siteKey], site: siteKey } : { ...MERRITT, site: "merritt" };
