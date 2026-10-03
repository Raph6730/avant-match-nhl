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
const PAUSE_ENTRE_APPELS = 400; // millisecondes entre deux appels (politesse envers la NHL)
const FICHIER_SORTIE = "data.json";
// ------------------------------

const API = "https://api-web.nhle.com/v1";
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

// Lit une adresse NHL. Si le serveur dit « trop de demandes » (429) ou est surchargé,
// on attend de plus en plus longtemps (jusqu'à 5 essais).
// Une même adresse n'est jamais lue deux fois pendant un passage du robot.
const dejaLu = new Map();
async function lire(chemin, fetcher) {
  const url = chemin.startsWith("http") ? chemin : API + chemin; // adresse complète = autre source
  if (dejaLu.has(url)) return dejaLu.get(url);
  let derniere;
  for (let essai = 1; essai <= 5; essai++) {
    let attente = 2000 * essai;
    try {
      const rep = await fetcher(url);
      if (rep.ok) {
        await pause(PAUSE_ENTRE_APPELS);
        const json = await rep.json();
        dejaLu.set(url, json);
        return json;
      }
      derniere = new Error(`Erreur ${rep.status} sur ${chemin}`);
      if (rep.status !== 429 && rep.status < 500) break; // inutile de réessayer
      if (rep.status === 429) {
        const indique = Number(rep.headers?.get?.("retry-after"));
        attente = indique > 0 ? indique * 1000 : 10000 * essai; // 10 s, 20 s, 30 s…
      }
    } catch (e) {
      derniere = new Error(`${e.message} sur ${chemin}`);
    }
    if (essai < 5) await pause(attente);
  }
  throw derniere;
}

const nomEquipe = (t) => `${t.placeName?.fr || t.placeName?.default || ""} ${t.commonName?.fr || t.commonName?.default || ""}`.trim();
const equipeCourte = (t) => ({ abbrev: t.abbrev, nom: nomEquipe(t), surnom: t.commonName?.default || "", logo: t.darkLogo || t.logo });

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

// ============================================================
//  5) LES BLESSÉS (source : liste publique d'ESPN, toute la NHL en un appel)
// ============================================================
const URL_BLESSES = "https://site.api.espn.com/apis/site/v2/sports/hockey/nhl/injuries";

// "Montréal" et "Montreal" doivent se reconnaître
const simple = (t) => String(t || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();

const STATUT = {
  "out": "Absent",
  "day-to-day": "Incertain",
  "injured reserve": "Liste des blessés",
  "injured list": "Liste des blessés",
  "questionable": "Incertain",
  "doubtful": "Douteux",
  "long-term injured reserve": "Liste des blessés (longue durée)",
  "suspension": "Suspendu",
  "suspended": "Suspendu",
};
const ZONE = {
  "upper body": "Haut du corps", "lower body": "Bas du corps", "head": "Tête", "concussion": "Commotion",
  "knee": "Genou", "ankle": "Cheville", "shoulder": "Épaule", "hand": "Main", "wrist": "Poignet",
  "back": "Dos", "groin": "Aine", "hip": "Hanche", "foot": "Pied", "leg": "Jambe", "neck": "Cou",
  "illness": "Maladie", "undisclosed": "Non communiqué", "personal": "Raison personnelle", "eye": "Œil",
  "elbow": "Coude", "face": "Visage", "finger": "Doigt", "hamstring": "Ischio-jambiers", "abdomen": "Abdomen",
};
const traduire = (table, v) => (v ? table[simple(v)] || v : "");

export function lireBlesses(json, equipesDuSoir) {
  const parEquipe = {};
  for (const bloc of json?.injuries || []) {
    const liste = bloc.injuries || [];
    const nomEspn = simple(bloc.displayName || liste[0]?.athlete?.team?.displayName);
    // On retrouve l'équipe par son surnom (ex. « Canadiens ») à la fin du nom ESPN
    const equipe = equipesDuSoir.find((e) => e.surnom && nomEspn.endsWith(simple(e.surnom)));
    if (!equipe) continue;
    parEquipe[equipe.abbrev] = liste.map((b) => ({
      nom: b.athlete?.displayName || b.athlete?.fullName || "",
      poste: b.athlete?.position?.abbreviation || "",
      statut: traduire(STATUT, b.status || b.type?.description),
      zone: traduire(ZONE, b.details?.type),
      precision: b.details?.location && b.details?.location !== b.details?.type ? traduire(ZONE, b.details.location) : "",
      retour: b.details?.returnDate || null,
      depuis: b.date ? String(b.date).slice(0, 10) : null,
    })).filter((b) => b.nom);
  }
  return parEquipe;
}

// ============================================================
//  6) LES COMPOS : alignement du dernier match, gardiens, habitués absents
// ============================================================
const aJoue = (j) => j.toi && j.toi !== "00:00";
const minutes = (toi) => { const [m, s] = String(toi || "0:0").split(":").map(Number); return (m || 0) + (s || 0) / 60; };

export function construireCompo(feuilles, matchs, abbrev) {
  // feuilles[0] = le match le plus récent
  const lignes = feuilles.map((f, i) => {
    const cote = f.homeTeam?.abbrev === abbrev ? "homeTeam" : "awayTeam";
    const st = f.playerByGameStats?.[cote] || {};
    const gardiensJoues = (st.goalies || []).filter(aJoue);
    // Le titulaire : indiqué par la NHL si disponible, sinon celui qui a joué le plus longtemps
    const titulaire = gardiensJoues.find((g) => g.starter === true)
      || [...gardiensJoues].sort((a, b) => minutes(b.toi) - minutes(a.toi))[0];
    return {
      match: matchs[i],
      attaquants: (st.forwards || []).filter(aJoue),
      defenseurs: (st.defense || []).filter(aJoue),
      gardiens: gardiensJoues,
      titulaire,
    };
  });
  if (!lignes.length) return null;

  // Rotation des gardiens sur les derniers matchs
  const gardiens = new Map();
  for (const l of lignes) {
    for (const g of l.gardiens) {
      const x = gardiens.get(g.playerId) || { nom: txt(g.name), titularisations: 0, matchs: 0, arrets: 0, tirs: 0, victoires: 0 };
      x.matchs += 1;
      if (l.titulaire?.playerId === g.playerId) x.titularisations += 1;
      x.arrets += g.saves ?? 0;
      x.tirs += g.shotsAgainst ?? 0;
      if (g.decision === "W") x.victoires += 1;
      gardiens.set(g.playerId, x);
    }
  }

  // Habitués absents : présents dans au moins 3 des matchs précédents, absents du dernier
  const dernier = lignes[0];
  const presentsDernier = new Set([...dernier.attaquants, ...dernier.defenseurs].map((j) => j.playerId));
  const avant = lignes.slice(1);
  const habitues = new Map();
  for (const l of avant) {
    for (const j of [...l.attaquants, ...l.defenseurs]) {
      const x = habitues.get(j.playerId) || { nom: txt(j.name), poste: j.position, fois: 0 };
      x.fois += 1;
      habitues.set(j.playerId, x);
    }
  }
  const absents = avant.length >= 3
    ? [...habitues.entries()].filter(([id, x]) => x.fois >= 3 && !presentsDernier.has(id)).map(([, x]) => ({ nom: x.nom, poste: x.poste, sur: avant.length, fois: x.fois }))
    : [];

  const nomsTries = (liste) => [...liste].sort((a, b) => minutes(b.toi) - minutes(a.toi)).map((j) => ({ nom: txt(j.name), poste: j.position, temps: j.toi }));
  return {
    dernierMatch: {
      date: dernier.match?.date || null,
      adversaire: dernier.match?.adversaire || "",
      domicile: dernier.match?.domicile ?? null,
      presaison: Boolean(dernier.match?.presaison),
      attaquants: nomsTries(dernier.attaquants),
      defenseurs: nomsTries(dernier.defenseurs),
      titulaire: dernier.titulaire ? txt(dernier.titulaire.name) : null,
    },
    gardiens: [...gardiens.values()]
      .map((g) => ({ ...g, pct: g.tirs ? g.arrets / g.tirs : null }))
      .sort((a, b) => b.titularisations - a.titularisations || b.matchs - a.matchs),
    nbMatchs: lignes.length,
    absents,
  };
}

// ============================================================
//  7) LE CLASSEMENT SAISONNIER (top 30 aux points, saison régulière)
// ============================================================
const NB_CLASSEMENT = 30;

export async function construireClassement(fetcher, saison) {
  // Source principale : les statistiques détaillées de la NHL
  try {
    const tri = encodeURIComponent(JSON.stringify([
      { property: "points", direction: "DESC" },
      { property: "goals", direction: "DESC" },
      { property: "gamesPlayed", direction: "ASC" },
    ]));
    const filtre = encodeURIComponent(`seasonId=${saison} and gameTypeId=2`);
    const json = await lire(`https://api.nhle.com/stats/rest/fr/skater/summary?isAggregate=false&isGame=false&start=0&limit=${NB_CLASSEMENT}&sort=${tri}&cayenneExp=${filtre}`, fetcher);
    const lignes = (json.data || []).map((j) => ({
      nom: j.skaterFullName || "",
      equipe: String(j.teamAbbrevs || "").split(",").pop().trim(), // dernière équipe si transfert
      poste: j.positionCode || "",
      mj: j.gamesPlayed ?? null,
      buts: j.goals ?? null,
      passes: j.assists ?? null,
      points: j.points ?? null,
      plusMoins: j.plusMinus ?? null,
      tirs: j.shots ?? null,
      pointsAN: j.ppPoints ?? null,
    })).filter((j) => j.nom).slice(0, NB_CLASSEMENT);
    if (lignes.length) return { source: "stats", lignes };
  } catch (e) {
    console.log(`::warning::Stats détaillées indisponibles, repli sur les meneurs : ${e.message}`);
  }
  // Repli : la liste des meneurs aux points (moins de colonnes)
  const json = await lire(`/skater-stats-leaders/current?categories=points&limit=${NB_CLASSEMENT}`, fetcher);
  return {
    source: "meneurs",
    lignes: (json.points || []).map((j) => ({
      nom: `${txt(j.firstName)} ${txt(j.lastName)}`.trim(),
      equipe: j.teamAbbrev || "",
      poste: j.position || "",
      points: j.value ?? null,
    })),
  };
}

export async function construireDonnees(fetcher = fetch) {
  const calendrier = await lire("/schedule/now", fetcher);
  const soir = extraireMatchsDuSoir(calendrier);

  const abbrevs = [...new Set(soir.matchs.flatMap((m) => [m.domicile.abbrev, m.exterieur.abbrev]))];
  const equipes = {};

  for (const abbrev of abbrevs) {
    let cal;
    try {
      cal = await lire(`/club-schedule-season/${abbrev}/now`, fetcher);
    } catch (e) {
      // Une équipe en échec ne doit pas bloquer tout le site
      console.log(`::warning::Calendrier indisponible pour ${abbrev} : ${e.message}`);
      equipes[abbrev] = { historique: [], joueurs: [], indisponible: true };
      continue;
    }
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
    const matchsLus = []; // le match correspondant à chaque feuille, dans le même ordre
    for (const m of forme) {
      try {
        feuilles.push(await lire(`/gamecenter/${m.id}/boxscore`, fetcher));
        matchsLus.push(m);
      } catch (e) {
        console.warn(`Feuille de match ${m.id} indisponible : ${e.message}`);
      }
    }

    equipes[abbrev] = {
      historique,
      joueurs: cumulerJoueurs(feuilles, abbrev, effectif),
      compo: construireCompo(feuilles, matchsLus, abbrev),
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

  // Les blessés : en cas d'échec, le site se met quand même à jour
  let blesses = null;
  try {
    const equipesDuSoir = soir.matchs.flatMap((m) => [m.domicile, m.exterieur]);
    const json = await lire(URL_BLESSES, fetcher);
    blesses = lireBlesses(json, equipesDuSoir);
    const premier = json?.injuries?.find((b) => b.injuries?.length)?.injuries?.[0];
    blesses._controle = premier ? Object.keys(premier) : [];
    console.log(`✓ Blessés : ${Object.keys(blesses).length - 1} équipes du soir trouvées`);
  } catch (e) {
    console.log(`::warning::Liste des blessés indisponible : ${e.message}`);
  }

  let classement = null;
  try {
    const saison = calendrier.gameWeek?.find((j) => j.games?.length)?.games?.[0]?.season;
    classement = await construireClassement(fetcher, saison);
    console.log(`✓ Classement saisonnier : ${classement.lignes.length} joueurs (${classement.source})`);
  } catch (e) {
    console.log(`::warning::Classement saisonnier indisponible : ${e.message}`);
  }

  return {
    misAJour: new Date().toISOString(),
    recap,
    blesses,
    classement,
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
