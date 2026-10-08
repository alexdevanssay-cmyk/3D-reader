# Passerelle IA de 3D Reader (`api/ai.js`)

Une petite fonction Vercel transmet les questions de la page « IA / analyse » à un modèle de langage en ligne : **Groq par défaut** (offre gratuite, modèle `openai/gpt-oss-120b`), ou un autre fournisseur compatible OpenAI. La clé d'API reste dans Vercel : elle n'est jamais dans la page, ni sur GitHub Pages.

## 1. Variables à créer dans Vercel

Projet `3-d-reader` → **Settings → Environment Variables**. Cochez **Production et Preview** : Preview sert aux adresses de test `https://3-d-reader-git-<branche>-3-d-madness.vercel.app`. Redéployez ensuite (**Deployments → … → Redeploy**) : une variable ne s'applique qu'aux déploiements faits après elle.

| Variable | | Rôle |
|---|---|---|
| `GROQ_API_KEY` | obligatoire | Clé Groq (`gsk_…`), créée dans la console Groq (**API Keys**). Le nom est reconnu quelle que soit la casse : `Groq_API_KEY` convient. |
| `READER3D_ACCESS_CODE` | conseillé | Code d'accès de votre choix. Sans lui, toute page autorisée peut consommer votre quota. La page le demande une fois et le garde dans le navigateur. |
| `READER3D_ALLOWED_ORIGINS` | facultatif | Sites autorisés à appeler la passerelle, séparés par des virgules ; `*` remplace une partie d'un nom. Par défaut : `https://alexdevanssay-cmyk.github.io` et `https://3-d-reader*-3-d-madness.vercel.app`. Le site Vercel qui sert la passerelle est toujours autorisé. Une liste donnée ici remplace celle par défaut. |
| `AI_MODEL` | facultatif | Modèle utilisé. Par défaut `openai/gpt-oss-120b` pour Groq. Gratuits chez Groq : `openai/gpt-oss-120b`, `openai/gpt-oss-20b`, `qwen/qwen3.8-27b` (préversion). |
| `AI_MODELS` | facultatif | Modèles que la page peut choisir (champ « Modèle »), séparés par des virgules. Sans cette liste, le champ « Modèle » est ignoré. |
| `AI_CONTEXT_CHARS` | facultatif | Taille du contexte envoyé, en caractères. Par défaut 9 000 pour Groq (environ 3 000 tokens), 16 000 sinon. |
| `AI_MAX_TOKENS` | facultatif | Longueur maximale d'une réponse, en tokens. Par défaut 1 200. |
| `AI_REASONING_EFFORT` | facultatif | Réflexion des modèles gpt-oss : `low` (par défaut), `medium` ou `high`. Plus de réflexion consomme plus de tokens. |

### Un autre fournisseur

Créez `AI_API_KEY`, `AI_BASE_URL` et `AI_MODEL` à la place de `GROQ_API_KEY` :

| Fournisseur | `AI_BASE_URL` |
|---|---|
| xAI | `https://api.x.ai/v1` |
| Google Gemini | `https://generativelanguage.googleapis.com/v1beta/openai` |
| Mistral | `https://api.mistral.ai/v1` |
| OpenAI | `https://api.openai.com/v1` (ou seulement `OPENAI_API_KEY` et `AI_MODEL`) |

`GROQ_API_KEY` est prioritaire : supprimez-la pour passer à un autre fournisseur. `AI_BASE_URL` seule change l'adresse de Groq (un proxy, par exemple).

## 2. Confidentialité

- Groq n'entraîne pas ses modèles sur les données reçues. Activez en plus **Zero Data Retention** dans les réglages de l'organisation de la console Groq : les requêtes ne sont alors pas conservées.
- Partent vers le fournisseur : la conversation et un contexte réduit de la pièce (mesures, features, analyse de fabrication et de fonderie). Le fichier 3D lui-même n'est jamais envoyé.
- Noms anonymisés : la case « Anonymiser les noms envoyés en ligne » (cochée par défaut) remplace, avant l'envoi, le nom du fichier, les noms des corps, la référence, la désignation, le client, le plan, les noms des noyaux et des composants, et les noms des fichiers du chiffrage par « Pièce », « Corps 1 », « Client »… Dans la question et la conversation aussi. Sous la réponse, la page rappelle les vrais noms des étiquettes citées. Le modèle local (Ollama) reçoit toujours les vrais noms : rien ne quitte le site.
- Tâche « Chiffrage » : les valeurs tracées du devis partent aussi. Les montants internes (taux, coûts, prix, marges, pertes au feu, TRS) sont masqués, sauf si la case « Envoyer les montants internes du chiffrage à la passerelle » est cochée (pour l'onglet du navigateur seulement).
- Le contexte est transmis au modèle comme des **données**, entre délimiteurs. Les textes venant du fichier CAO ou du devis ne sont jamais suivis comme des instructions.
- L'IA explique, elle ne fixe aucune valeur : rien de ce qu'elle répond n'est appliqué au devis ni aux paramètres. Chaque nombre d'une réponse « Chiffrage » est comparé à la trace envoyée, sinon la réponse est marquée « non vérifiée ».
- Estimation du temps de cycle (bouton « Estimer le temps de cycle avec l'IA » de la page Chiffrage) : partent la géométrie de la pièce (poids, module, épaisseurs, encombrement, volume, surface, noyaux), sa coulée (îlot, pièces par cycle, mise au mille, série), le temps de la formule et ses termes, la tendance et, si la case « Envoyer les pièces similaires de l'historique » est cochée, les 5 pièces les plus semblables de l'historique avec leur temps de cycle et leur source. Les références de ces pièces sont remplacées par « Historique 1 »… avec les autres noms. L'estimation est une proposition : elle n'entre dans le devis que si l'on clique « Utiliser cette valeur ».

## 3. Limites de l'offre gratuite de Groq

Par modèle et par organisation : 30 requêtes par minute, 1 000 par jour, 8 000 tokens par minute, 200 000 tokens par jour.

- Une question d'analyse consomme jusqu'à 4 000 à 5 000 tokens : les règles, le contexte (9 000 caractères au plus), la conversation récente et la réponse (1 200 tokens au plus). Comptez **une à deux questions d'analyse par minute**, davantage pour des questions générales (contexte résumé).
- Après chaque réponse, la page affiche le fournisseur, le modèle et le nombre de questions restantes aujourd'hui.
- Quota atteint : la page affiche « Quota de Groq (offre gratuite) atteint. Réessayez dans … ». Une question trop longue pour une minute est refusée : commencez une nouvelle conversation ou choisissez une analyse plus ciblée.
- Repli automatique : avec la case « Repli automatique sur le modèle local » (cochée par défaut), une question refusée pour quota (HTTP 413 ou 429) est posée au modèle local Ollama, s'il répond, avec l'adresse et le modèle choisis pour lui. La réponse porte la mention « Quota en ligne atteint : réponse du modèle local (…) ».
- « Banc d'essai IA » (carte « Historique des temps de cycle » de la page Chiffrage) : une estimation du temps de cycle par pièce de l'historique, une demande à la fois. D'abord une toutes les 20 s, puis au rythme que permettent les tokens par minute renvoyés par la passerelle (environ une toutes les 30 à 40 s avec l'offre gratuite). Un refus pour quota arrête la série, sans repli sur le modèle local ; « Reprendre » la continue après le délai indiqué. Comptez de l'ordre de 4 000 tokens par pièce : un historique de 25 pièces prend environ un quart d'heure et la moitié des 200 000 tokens du jour.
- La passerelle limite aussi chaque adresse IP à 20 requêtes par minute. Ce compteur est tenu par chaque instance de la fonction, et Vercel peut en lancer plusieurs : c'est un frein, pas une limite exacte.
- Une requête fait au plus 200 Ko. Le fournisseur a 50 secondes pour répondre : la fonction est limitée à 60 secondes (`vercel.json`, offre Hobby).

## 4. Tester

1. Après le redéploiement, ouvrez `https://<projet>.vercel.app/api/ai` (l'adresse de **Settings → Domains**, ou celle d'un déploiement de test). La réponse ressemble à :
   `{"provider":"Groq","model":"openai/gpt-oss-120b","models":[],"context_chars":9000,"access_code_required":false}`
   Avec un code d'accès, cette adresse ouverte directement répond « Code d'accès requis » : c'est normal. Testez alors avec curl :
   ```
   curl -s https://<projet>.vercel.app/api/ai -H "X-Reader3D-Code: <code>"
   curl -s https://<projet>.vercel.app/api/ai -H "Content-Type: application/json" -H "X-Reader3D-Code: <code>" \
     -d '{"task":"general","messages":[{"role":"user","content":"Bonjour"}]}'
   ```
2. Dans 3D Reader, page **IA / analyse** : fournisseur « En ligne via la passerelle (Groq…) ». Sur Vercel, l'adresse est déjà remplie. Sur GitHub Pages, collez `https://<projet>.vercel.app/api/ai`.
3. Cliquez **Tester la connexion** : « Passerelle connectée : Groq · openai/gpt-oss-120b · … ». Si un code est demandé, le champ « Code d'accès » apparaît : saisissez-le, puis testez à nouveau.

## 5. Messages d'erreur

| Message | Que faire |
|---|---|
| Aucune clé d'API sur la passerelle | Créez `GROQ_API_KEY` pour l'environnement concerné (Production ou Preview), puis redéployez. |
| Clé d'API refusée par Groq | Clé erronée ou révoquée : recréez-la dans la console Groq, mettez à jour la variable, redéployez. |
| Origine non autorisée | Ajoutez l'adresse de la page à `READER3D_ALLOWED_ORIGINS`. Dans la page, cela s'affiche comme « La passerelle est injoignable ». |
| Code d'accès requis / incorrect | Saisissez le code de `READER3D_ACCESS_CODE` dans le champ « Code d'accès ». |
| Quota … atteint | Attendez le délai indiqué. |
| Modèle introuvable | Corrigez `AI_MODEL`. |
| … n'a pas répondu en 50 s | Réessayez, ou posez une question plus courte. |

Le détail technique de chaque refus du fournisseur est écrit dans les journaux de la fonction (Vercel → **Logs**) ; la page n'en reçoit jamais le texte.

## Pour les développeurs

- `GET /api/ai` : configuration publique `{provider, model, models, context_chars, access_code_required}`, jamais un secret.
- `POST /api/ai` : `{task, model, context, messages}`, avec l'en-tête `X-Reader3D-Code` si un code est défini. Réponse : `{output, provider, model, quota, usage}`, où `quota` reprend les en-têtes `x-ratelimit-*` du fournisseur : `requests_remaining_day`, `requests_limit_day`, `tokens_remaining_minute`, `tokens_limit_minute`, `reset_requests`, `reset_tokens` ; `usage` (quand le fournisseur le donne) : `prompt_tokens`, `completion_tokens`, `total_tokens`. Le banc d'essai de la page Chiffrage règle son rythme avec eux. En cas d'erreur : `{error}` en français, plus `retry_after` (secondes) ou `access_code_required` selon le cas.
- Appel au fournisseur : `POST {AI_BASE_URL}/chat/completions`. Les règles vont en message système. Le contexte suit dans un message à part, entre délimiteurs, puis viennent les 20 derniers messages de la conversation. Réponse en texte simple, sauf deux tâches en JSON (`response_format` `json_schema` strict, puis `json_object` avec le schéma dans les règles si le fournisseur le refuse) : `costing` (`analyse_chiffrage`) et `cycle_time` (estimation du temps de cycle de coulée : `estimation_s`, `fourchette_s`, `confiance`, `decomposition`, `comparaison`, `pieces_similaires_utilisees`, `hypotheses`, `a_verifier` ; schéma `CYCLE_SCHEMA`, le même que celui de `web/chiffrage/ai-cycle.js`). Un paramètre refusé (`reasoning_effort`, `temperature`, `max_completion_tokens`) est retiré ou remplacé, une fois.
- Une estimation du temps de cycle tient dans la limite de réponse par défaut (1 200 tokens) : si elle était coupée (« Réponse de Groq coupée »), augmentez `AI_MAX_TOKENS` (par exemple 2 000).
- Tests : `tests/js/ai-gateway.test.mjs` (fonction seule, fournisseur simulé), `tests/js/ai-cycle.test.mjs` (estimation du temps de cycle), `tests/e2e/features.test.mjs` (la page avec la passerelle et un Groq simulé) et `tests/e2e/costing.test.mjs` (la page Chiffrage avec une passerelle simulée qui répond à `cycle_time`, estimation et banc d'essai), `tests/js/backtest.test.mjs` (rythme, arrêt sur quota et reprise du banc d'essai).
