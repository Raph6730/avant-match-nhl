# Avant-Match NHL — mode d'emploi

Ton outil d'analyse des matchs NHL du soir, pour parieurs.

## Ce qu'il y a dans le dossier

| Fichier | À quoi il sert | Tu y touches ? |
|---|---|---|
| `index.html` | La page que voient les visiteurs, et le calcul de l'indicateur | Oui : textes, couleurs (en haut, dans `:root`), règles de l'indicateur (début du script, « RÉGLAGES DE L'INDICATEUR ») |
| `robot/recuperer-donnees.mjs` | Le robot qui va chercher les données NHL | Rarement : seulement si la NHL change ses données |
| `confidentialite.html`, `mentions-legales.html` | Les pages légales (liées en bas du site) | Si tes pratiques changent |
| `polices/` | Les polices du site, hébergées ici plutôt que chez Google | Non |
| `.github/workflows/mise-a-jour.yml` | Le planning : lance le robot vers 7h, 8h47 et 16h47 (heure de Paris, une heure plus tôt en hiver) et met le site à jour | Presque jamais |

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
- Pas de gardiens titulaires probables, pas de cotes, pas de vidéos des buts.
- Les blessés viennent de la liste publique d'ESPN (source non officielle, comme celle de la NHL).
- « Repos » compte les jours depuis le dernier match joué ; « Back-to-back » = l'équipe a joué la veille.
- Le récap de la nuit montre les matchs de la veille (heure de New York) ; GitHub peut lancer le robot avec 10 à 30 minutes de retard.
- Saison en cours uniquement : tant qu'une équipe a joué moins de 3 matchs, l'indicateur affiche « Trop tôt pour juger ».
- Source NHL non officielle : elle peut changer sans prévenir.

## Activer la publicité (Google AdSense)

1. Crée ton compte sur adsense.google.com et déclare le site.
2. Dans AdSense, crée un bloc d'annonces « display ». Note ton identifiant éditeur (`ca-pub-…`) et l'identifiant du bloc.
3. Dans `index.html`, remplis `PUB_CLIENT` et `PUB_EMPLACEMENT` (section « PUBLICITÉS »). Les bannières apparaissent après le 2e match de chaque liste.
4. Dans AdSense → « Confidentialité et messages », active le message de consentement RGPD de Google (obligatoire en Europe).
5. Le fichier `ads.txt` doit être à la racine `raph6730.github.io/ads.txt` : il vit dans un dépôt séparé nommé `raph6730.github.io`.
