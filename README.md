# KelJayden Créations — prêt pour Render

Le projet est configuré pour être hébergé sur Render avec Node.js.

## Configuration Render
Le fichier `render.yaml` prépare :
- le Web Service Node.js ;
- `npm install` puis `npm start` ;
- un disque persistant de 1 Go monté sur `/var/data` ;
- SQLite dans `/var/data/keljayden.db` ;
- les variables secrètes à saisir dans Render.

## Variables à saisir dans Render
- `APP_URL` : l'adresse HTTPS publique du site (ex. `https://keljayden-creations.onrender.com`)
- `ADMIN_EMAIL` : adresse administrateur
- `ADMIN_PASSWORD` : mot de passe initial (utile surtout si la base est neuve)
- `STRIPE_SECRET_KEY`
- `STRIPE_WEBHOOK_SECRET`
- `RESEND_API_KEY`
- `EMAIL_FROM`

`JWT_SECRET` est généré automatiquement par Render.

## Stripe
Après mise en ligne, créer dans Stripe un webhook vers :
`https://VOTRE-DOMAINE/api/stripe/webhook`

Puis copier le secret `whsec_...` dans `STRIPE_WEBHOOK_SECRET`.

## Base SQLite existante
Si vous voulez conserver les produits, comptes et commandes déjà présents, votre base `keljayden.db` actuelle doit être transférée sur le disque persistant `/var/data` avant d'utiliser le site en production.

Ne publiez jamais un fichier `.env` contenant vos clés Stripe ou Resend.

## Livraison (tarifs fixes)

Au paiement, le client choisit Mondial Relay (4,50 €, point relais indiqué manuellement) ou Colissimo (6,90 €, domicile). Livraison offerte dès 70 € après réduction. Livraison limitée à la France. Les choix et coordonnées sont conservés dans la base de données et visibles dans l'administration. L'achat d'étiquettes et la sélection automatique d'un point relais ne sont pas intégrés.
