# Avant-Match NHL — mode d'emploi

Ton outil d'analyse des matchs NHL du soir, pour parieurs.

## Ce qu'il y a dans le dossier

| Fichier | À quoi il sert | Tu y touches ? |
|---|---|---|
| `index.html` | La page que voient les visiteurs, et le calcul de l'indicateur | Oui : textes, couleurs (en haut, dans `:root`), règles de l'indicateur (début du script, « RÉGLAGES DE L'INDICATEUR ») |
| `robot/recuperer-donnees.mjs` | Le robot qui va chercher les données NHL | Rarement : seulement si la NHL change ses données |
| `.github/workflows/mise-a-jour.yml` | Le planning : lance le robot vers 8h47 et 16h47 (heure de Paris) et met le site à jour | Presque jamais |

## Mettre le site en ligne (une seule fois, ~15 minutes)

1. **Crée un compte gratuit** sur github.com.
2. **Crée un dépôt** (bouton « New repository ») : nom `avant-match-nhl`, coche **Public**, puis « Create repository ».
3. **Envoie les fichiers** : sur la page du dépôt, clique « uploading an existing file » et glisse **le contenu** du dossier (pas le dossier lui-même). Valide avec « Commit changes ».
   - Le dossier `.github` est caché sur Mac/Windows. Sur Mac : `Cmd + Maj + .` dans le Finder pour l'afficher. Il doit absolument être envoyé, c'est le planning du robot.
4. **Active la publication** : onglet **Settings** → **Pages** → dans « Source », choisis **GitHub Actions**.
5. **Lance le robot une première fois** : onglet **Actions** → « Mise à jour du site » → bouton **Run workflow**. Attends la coche verte (1 à 2 minutes).
6. Ton site est en ligne à l'adresse : `https://TON-PSEUDO.github.io/avant-match-nhl/`

## Modifier le site

Ouvre `index.html` sur GitHub, clique sur le crayon ✏️, modifie, puis « Commit changes ». Le site se met à jour tout seul en 1 à 2 minutes.

## Si quelque chose casse

- **Le site affiche « Impossible de charger les données »** : onglet Actions → regarde si la dernière exécution est rouge. Clique dessus pour lire l'erreur.
- **Une croix rouge dans Actions** : souvent la NHL a modifié sa source de données. Copie le message d'erreur et demande de l'aide.
- **GitHub désactive le planning après 60 jours sans activité sur le dépôt.** Si les données ne bougent plus, onglet Actions → réactive le workflow (un bandeau jaune le propose).

## Limites connues (volontaires pour le test)

- En début de saison, la forme est complétée par les matchs de présaison de l'année en cours (signalés en pointillés). Seuls les joueurs de l'effectif actuel sont affichés.
- Pas de gardiens titulaires probables, pas de blessés, pas de cotes.
- Saison en cours uniquement : tant qu'une équipe a joué moins de 3 matchs, l'indicateur affiche « Trop tôt pour juger ».
- Source NHL non officielle : elle peut changer sans prévenir.
