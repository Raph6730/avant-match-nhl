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

async function lire(chemin, fetcher) {
  const rep = await fetcher(API + chemin);
  if (!rep.ok) throw new Error(`Erreur ${rep.status} sur ${chemin}`);
  await pause(PAUSE_ENTRE_APPELS);
  return rep.json();
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

  return {
    misAJour: new Date().toISOString(),
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
      process.exit(1);
    });
}
