# Parfum — carnet de projets

Application locale de suivi des projets d’évaluation en parfumerie. Les données restent sur l’ordinateur et l’application ne se connecte pas aux logiciels de l’entreprise.

## Démarrage sous Windows

1. Décompressez le dossier `parfum-projets` dans un emplacement où vous avez les droits d’écriture, par exemple Documents.
2. Double-cliquez sur **Lancer Parfum.exe**.
3. Au premier démarrage, une connexion Internet est nécessaire pour récupérer Node.js et les dépendances de l’application. Node.js est vérifié avec l’empreinte publiée par son site officiel.
4. Votre navigateur s’ouvre dès que l’application est prête. Aucun terminal n’est affiché.

Pour fermer l’application et sa base locale proprement, double-cliquez sur **Fermer Parfum.exe**. Les données sont conservées dans `%LOCALAPPDATA%\ParfumProjets`, même si vous déplacez ou remplacez le dossier de l’application.

## Fonctionnalités

- Vue d’ensemble avec calendrier hebdomadaire navigable et projets triés par échéance.
- Liste des projets avec recherche et filtres par statut et décision.
- Fiche détaillée, notes personnelles, références, RMC et suivi de l’étape courante.
- Équipe répartie entre commercial, assistant commercial et parfumeurs.
- Références et intervenants réutilisables entre les projets.
- Données locales dans PostgreSQL, chaque ligne disposant d’un identifiant unique.

## Stockage

- Windows : `%LOCALAPPDATA%\ParfumProjets`
- Base PostgreSQL : `%LOCALAPPDATA%\ParfumProjets\data\postgres-data`
- Journaux de démarrage : `%LOCALAPPDATA%\ParfumProjets\logs`

Le lanceur est une petite application Windows native. Il n’utilise ni PowerShell ni VBScript pour démarrer l’application. Il démarre le serveur Node.js sans fenêtre de terminal et le navigateur affiche l’interface. Ce paquet n’est pas signé avec un certificat éditeur ; Windows peut donc afficher un avertissement de réputation lors du premier lancement.

## Dépannage

Si le démarrage échoue, vérifiez la connexion Internet au premier lancement et consultez `installation.log` ou `server.log` dans le dossier `logs` indiqué ci-dessus. Ne restaurez pas un fichier que Microsoft Defender a supprimé et ne créez pas d’exclusion antivirus sans vérification du fichier concerné.
