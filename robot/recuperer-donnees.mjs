// ============================================================
//  ROBOT DE RÉCUPÉRATION DES DONNÉES NHL
// ------------------------------------------------------------
//  Rôle : le "livreur". Il va chercher les données sur le site
//  de la NHL et les range dans le fichier data.json, que la
//  page index.html lit ensuite.
//
//  Il est lancé automatiquement par GitHub (voir le fichier
//  .github/workflows/mise-a-jour.yml). Tu n'as normalement
//  jamais besoin d'y toucher.
//
//  Réglages modifiables sont juste en dessous.
// ============================================================

import { writeFile } from "node:fs/promises";

// ---------- RÉGLAGES ----------
const NB_MATCHS_FORME = 5;      // matchs utilisés pour la forme (équipes + joueurs)
const NB_MATCHS_DOM_EXT = 10;   // matchs utilisés pour le bilan domicile / extérieur
const NB_JOUEURS_GARDES = 8;    // joueurs gardés par équipe dans le fichier
const PAUSE_ENTRE_APPELS = 200; // millisecondes entre deux appels (politesse envers la NHL)
const FICHIER_SORTIE = "data.json";
// ------------------------------

const API = "https://api-web.nhle.com/v1";
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

// Lit une adresse NHL, avec 3 essais si le serveur est surchargé ou coupe la connexion
async function lire(chemin, fetcher) {
  let derniere;
  for (let essai = 1; essai <= 3; essai++) {
    try {
      const rep = await fetcher(API + chemin);
      if (rep.ok) {
        await pause(PAUSE_ENTRE_APPELS);
        return await rep.json();
      }
      derniere = new Error(`Erreur ${rep.status} sur ${chemin}`);
      if (rep.status !== 429 && rep.status < 500) break; // inutile de réessayer
    } catch (e) {
      derniere = new Error(`${e.message} sur ${chemin}`);
    }
    await pause(1500 * essai);
  }
  throw derniere;
}

const nomEquipe = (t) => `${t.placeName?.fr || t.placeName?.default || ""} ${t.commonName?.fr || t.commonName?.default || ""}`.trim();
const equipeCourte = (t) => ({ abbrev: t.abbrev, nom: nomEquipe(t), logo: t.darkLogo || t.logo });

// 1) Les matchs du soir : le premier jour du calendrier qui a encore des matchs à venir
export function extraireMatchsDuSoir(calendrier) {
  for (const jour of calendrier.gameWeek || []) {
    const aVenir = (jour.games || []).filter(
      (g) => ["FUT", "PRE"].includes(g.gameState) && [2, 3].includes(g.gameType)
    );
    if (aVenir.length) {
      return {
        date: jour.date,
        matchs: aVenir.map((g) => ({
          id: g.id,
          debutUTC: g.startTimeUTC,
          domicile: equipeCourte(g.homeTeam),
          exterieur: equipeCourte(g.awayTeam),
        })),
      };
    }
  }
  return { date: null, matchs: [] };
}

// 2) Les derniers matchs terminés d'une équipe
//    type 1 = présaison, 2 = saison régulière, 3 = séries
export function matchsTermines(calendrierEquipe, abbrev) {
  return (calendrierEquipe.games || [])
    .filter((g) => ["OFF", "FINAL"].includes(g.gameState) && [1, 2, 3].includes(g.gameType))
    .map((g) => {
      const aDomicile = g.homeTeam.abbrev === abbrev;
      const nous = aDomicile ? g.homeTeam : g.awayTeam;
      const eux = aDomicile ? g.awayTeam : g.homeTeam;
      const prolongation = ["OT", "SO"].includes(g.gameOutcome?.lastPeriodType);
      return {
        id: g.id,
        date: g.gameDate,
        saison: g.season,
        adversaire: eux.abbrev,
        domicile: aDomicile,
        butsPour: nous.score,
        butsContre: eux.score,
        victoire: nous.score > eux.score,
        prolongation,
        presaison: g.gameType === 1,
      };
    })
    .sort((a, b) => (a.date < b.date ? 1 : -1)); // du plus récent au plus ancien
}

// 3) Les stats des joueurs sur les derniers matchs, à partir des feuilles de match
//    effectif = numéros des joueurs de l'effectif actuel (ou null = pas de filtre)
export function cumulerJoueurs(feuilles, abbrev, effectif = null) {
  const joueurs = new Map();
  for (const f of feuilles) {
    const cote = f.homeTeam.abbrev === abbrev ? "homeTeam" : "awayTeam";
    const stats = f.playerByGameStats?.[cote];
    if (!stats) continue;
    for (const p of [...(stats.forwards || []), ...(stats.defense || [])]) {
      if (effectif && !effectif.has(p.playerId)) continue; // joueur plus dans l'équipe
      const j = joueurs.get(p.playerId) || {
        id: p.playerId, nom: p.name?.default, poste: p.position,
        matchs: 0, buts: 0, passes: 0, points: 0, tirs: 0,
      };
      j.matchs += 1;
      j.buts += p.goals || 0;
      j.passes += p.assists || 0;
      j.points += p.points || 0;
      j.tirs += p.sog || 0;
      joueurs.set(p.playerId, j);
    }
  }
  return [...joueurs.values()]
    .sort((a, b) => b.points - a.points || b.buts - a.buts || b.tirs - a.tirs)
    .slice(0, NB_JOUEURS_GARDES);
}

// ============================================================
//  4) LE RÉCAP DE LA NUIT (scores, buteurs, passeurs, étoiles)
// ============================================================

// Les textes NHL arrivent parfois en simple texte, parfois en { default: "..." }
const txt = (v) => (typeof v === "string" ? v : v?.fr || v?.default || "");

// La "nuit" en France = les matchs de la veille, heure de New York
export function dateDeLaNuit(maintenant = new Date()) {
  const ny = new Date(maintenant.toLocaleString("en-US", { timeZone: "America/New_York" }));
  ny.setDate(ny.getDate() - 1);
  const z = (n) => String(n).padStart(2, "0");
  return `${ny.getFullYear()}-${z(ny.getMonth() + 1)}-${z(ny.getDate())}`;
}

const FORCE = { pp: "AN", sh: "IN", ev: "" }; // avantage / infériorité numérique

export function lireBut(b, abbrevDom, abbrevExt) {
  const periode = b.periodDescriptor?.number ?? b.period ?? null;
  const typePeriode = b.periodDescriptor?.periodType || (periode === 4 ? "OT" : periode >= 5 ? "SO" : "REG");
  const nom = txt(b.name) || `${txt(b.firstName)} ${txt(b.lastName)}`.trim();
  const equipe = txt(b.teamAbbrev) || (b.isHome === true ? abbrevDom : b.isHome === false ? abbrevExt : "");
  const force = String(b.strength || b.situation || "").toLowerCase();
  return {
    periode,
    typePeriode,
    temps: b.timeInPeriod || "",
    equipe,
    buteur: nom,
    totalSaison: b.goalsToDate ?? null,
    passes: (b.assists || []).map((a) => ({
      nom: txt(a.name) || `${txt(a.firstName)} ${txt(a.lastName)}`.trim(),
      total: a.assistsToDate ?? null,
    })),
    situation: [FORCE[force] || "", /empty/i.test(b.goalModifier || "") ? "FV" : ""].filter(Boolean).join(" "),
    scoreExt: b.awayScore ?? null,
    scoreDom: b.homeScore ?? null,
  };
}

export function lireEtoiles(landing) {
  const etoiles = landing?.summary?.threeStars || [];
  return etoiles
    .map((e) => ({
      rang: e.star,
      nom: txt(e.name) || `${txt(e.firstName)} ${txt(e.lastName)}`.trim(),
      equipe: txt(e.teamAbbrev),
      poste: e.position || "",
      buts: e.goals ?? null,
      passes: e.assists ?? null,
    }))
    .filter((e) => e.nom)
    .sort((a, b) => a.rang - b.rang);
}

// Les gardiens qui ont joué, lus dans la feuille de match
export function lireGardiens(feuille) {
  const res = [];
  for (const cote of ["awayTeam", "homeTeam"]) {
    const equipe = feuille?.[cote]?.abbrev || "";
    for (const g of feuille?.playerByGameStats?.[cote]?.goalies || []) {
      if (!g.toi || g.toi === "00:00") continue; // n'est pas entré sur la glace
      const tirs = g.shotsAgainst ?? null;
      const arrets = g.saves ?? (tirs != null && g.goalsAgainst != null ? tirs - g.goalsAgainst : null);
      res.push({
        equipe,
        nom: txt(g.name),
        arrets,
        tirs,
        buts: g.goalsAgainst ?? null,
        pct: g.savePctg ?? (tirs ? arrets / tirs : null),
        temps: g.toi,
        decision: g.decision || "", // W = victoire, L = défaite, O = défaite en prolongation
      });
    }
  }
  return res;
}

export async function construireRecap(fetcher, date = dateDeLaNuit()) {
  const jour = await lire(`/score/${date}`, fetcher);
  const matchs = [];
  for (const g of jour.games || []) {
    if (![1, 2, 3].includes(g.gameType)) continue;
    const dom = g.homeTeam, ext = g.awayTeam;
    const termine = ["OFF", "FINAL"].includes(g.gameState);
    const fin = g.gameOutcome?.lastPeriodType || g.periodDescriptor?.periodType || "REG";
    let etoiles = [];
    let gardiens = [];
    if (termine) {
      try {
        etoiles = lireEtoiles(await lire(`/gamecenter/${g.id}/landing`, fetcher));
      } catch (e) {
        console.warn(`Étoiles indisponibles pour ${g.id} : ${e.message}`);
      }
      try {
        gardiens = lireGardiens(await lire(`/gamecenter/${g.id}/boxscore`, fetcher));
      } catch (e) {
        console.warn(`Gardiens indisponibles pour ${g.id} : ${e.message}`);
      }
    }
    matchs.push({
      id: g.id,
      presaison: g.gameType === 1,
      etat: termine ? "termine" : ["LIVE", "CRIT"].includes(g.gameState) ? "en-cours" : "a-venir",
      fin, // REG, OT (prolongation) ou SO (tirs au but)
      domicile: { abbrev: dom.abbrev, nom: txt(dom.name) || txt(dom.commonName), score: dom.score ?? null, tirs: dom.sog ?? null },
      exterieur: { abbrev: ext.abbrev, nom: txt(ext.name) || txt(ext.commonName), score: ext.score ?? null, tirs: ext.sog ?? null },
      buts: (g.goals || []).map((b) => lireBut(b, dom.abbrev, ext.abbrev)),
      etoiles,
      gardiens,
    });
  }
  // Contrôle : les clés du premier but reçu, pour vérifier le format NHL
  const premier = (jour.games || []).find((x) => x.goals?.length)?.goals?.[0];
  return { date, matchs, controle: premier ? Object.keys(premier) : [] };
}

export async function construireDonnees(fetcher = fetch) {
  const calendrier = await lire("/schedule/now", fetcher);
  const soir = extraireMatchsDuSoir(calendrier);

  const abbrevs = [...new Set(soir.matchs.flatMap((m) => [m.domicile.abbrev, m.exterieur.abbrev]))];
  const equipes = {};

  for (const abbrev of abbrevs) {
    const cal = await lire(`/club-schedule-season/${abbrev}/now`, fetcher);
    // Saison en cours uniquement : les effectifs changent trop d'une saison à l'autre.
    const saison = matchsTermines(cal, abbrev).filter((m) => !cal.currentSeason || m.saison === cal.currentSeason);
    const officiels = saison.filter((m) => !m.presaison).slice(0, NB_MATCHS_DOM_EXT);
    // Début de saison : on complète avec la présaison de CETTE année (signalée sur le site).
    const manque = Math.max(0, NB_MATCHS_FORME - officiels.length);
    const presaison = saison.filter((m) => m.presaison).slice(0, manque);
    const historique = [...officiels, ...presaison].sort((a, b) => (a.date < b.date ? 1 : -1));
    const forme = [...officiels.slice(0, NB_MATCHS_FORME), ...presaison];

    // L'effectif actuel, pour ne garder que les joueurs encore dans l'équipe
    let effectif = null;
    try {
      const roster = await lire(`/roster/${abbrev}/current`, fetcher);
      const ids = Object.values(roster).filter(Array.isArray).flat().map((j) => j.id).filter(Boolean);
      if (ids.length) effectif = new Set(ids);
    } catch (e) {
      console.warn(`Effectif indisponible pour ${abbrev} : ${e.message}`);
    }

    const feuilles = [];
    for (const m of forme) {
      try {
        feuilles.push(await lire(`/gamecenter/${m.id}/boxscore`, fetcher));
      } catch (e) {
        console.warn(`Feuille de match ${m.id} indisponible : ${e.message}`);
      }
    }

    equipes[abbrev] = {
      historique,
      joueurs: cumulerJoueurs(feuilles, abbrev, effectif),
    };
    console.log(`✓ ${abbrev} : ${officiels.length} matchs officiels + ${presaison.length} de présaison, effectif ${effectif ? effectif.size + " joueurs" : "non filtré"}`);
  }

  // Le récap ne doit jamais empêcher le reste du site de se mettre à jour
  let recap = null;
  try {
    recap = await construireRecap(fetcher);
    console.log(`✓ Récap de la nuit (${recap.date}) : ${recap.matchs.length} matchs`);
  } catch (e) {
    console.log(`::warning::Récap de la nuit indisponible : ${e.message}`);
  }

  return {
    misAJour: new Date().toISOString(),
    recap,
    saisonEnCours: calendrier.gameWeek?.[0]?.games?.[0]?.season || null,
    dateDesMatchs: soir.date,
    reglages: { nbMatchsForme: NB_MATCHS_FORME, nbMatchsDomExt: NB_MATCHS_DOM_EXT },
    matchs: soir.matchs,
    equipes,
  };
}

// Lancement direct (par GitHub) : on construit et on écrit le fichier
if (import.meta.url === `file://${process.argv[1]}`) {
  construireDonnees()
    .then(async (donnees) => {
      await writeFile(FICHIER_SORTIE, JSON.stringify(donnees));
      console.log(`Terminé : ${donnees.matchs.length} matchs enregistrés dans ${FICHIER_SORTIE}`);
    })
    .catch((e) => {
      console.error("Échec du robot :", e);
      // ligne lisible dans le résumé de l'exécution sur GitHub
      console.log(`::error::Échec du robot : ${String(e.stack || e).replace(/\n/g, " | ")}`);
      process.exit(1);
    });
}
