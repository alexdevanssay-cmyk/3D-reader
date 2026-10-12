# Passerelle IA de 3D Reader (`api/ai.js`)

Une petite fonction Vercel transmet les questions de la page « IA / analyse » à un modèle de langage en ligne : **Groq par défaut** (offre gratuite, modèle `openai/gpt-oss-120b`), ou un autre fournisseur compatible OpenAI. La clé d'API reste dans Vercel : elle n'est jamais dans la page, ni sur GitHub Pages.

## 1. Variables à créer dans Vercel

Projet `3-d-reader` → **Settings → Environment Variables**. Cochez **Production et Preview** : Preview sert aux adresses de test `https://3-d-reader-git-<branche>-3-d-madness.vercel.app`. Redéployez ensuite (**Deployments → … → Redeploy**) : une variable ne s'applique qu'aux déploiements faits après elle.

| Variable | | Rôle |
|---|---|---|
| `GROQ_API_KEY` | obligatoire | Clé Groq (`gsk_…`), créée dans la console Groq (**API Keys**). Le nom est reconnu quelle que soit la casse : `Groq_API_KEY` convient. |
| `READER3D_ACCESS_CODE` | obligatoire | Code d'accès de votre choix, long et aléatoire (une trentaine de caractères tirés au hasard, par exemple d'un gestionnaire de mots de passe). Sans lui, la passerelle refuse tout (« Aucun code d'accès sur la passerelle ») : n'importe qui connaissant son adresse (une page, un script, curl) pourrait sinon consommer votre quota, ou votre crédit chez un fournisseur payant. La liste des sites autorisés ne protège que des pages : un script n'envoie pas d'origine. La page demande le code une fois et le garde dans le navigateur. |
| `READER3D_PUBLIC` | déconseillé | `1` : passerelle ouverte à tous, sans code d'accès. |
| `READER3D_ALLOWED_ORIGINS` | facultatif | Sites autorisés à appeler la passerelle, séparés par des virgules ; `*` remplace une partie d'un nom. Par défaut : `https://alexdevanssay-cmyk.github.io` et `https://3-d-reader*-3-d-madness.vercel.app`. Le site Vercel qui sert la passerelle est toujours autorisé. Une liste donnée ici remplace celle par défaut. |
| `AI_MODEL` | facultatif | Modèle utilisé. Par défaut `openai/gpt-oss-120b` pour Groq. Gratuits chez Groq : `openai/gpt-oss-120b`, `openai/gpt-oss-20b`, `qwen/qwen3.8-27b` (préversion). |
| `AI_MODELS` | facultatif | Modèles que la page peut choisir (champ « Modèle », qui les propose), séparés par des virgules. Sans cette liste, le champ « Modèle » est désactivé : la passerelle répond avec `AI_MODEL`. Un modèle hors de la liste est ignoré, et la page le dit sous la réponse. |
| `AI_CONTEXT_CHARS` | facultatif | Taille du contexte envoyé, en caractères. Par défaut 9 000 pour Groq (environ 3 000 tokens), 16 000 sinon. |
| `AI_MAX_TOKENS` | facultatif | Longueur maximale d'une réponse, en tokens. Par défaut 1 200. |
| `AI_TOKENS_PER_DAY` | facultatif | Tokens utilisables par jour, pour estimer les questions restantes (badge de la page IA). Par défaut, ceux de l'offre gratuite de Groq pour `openai/gpt-oss-120b` et `openai/gpt-oss-20b` (200 000) ; à définir avec une autre offre ou un autre modèle. |
| `AI_REASONING_EFFORT` | facultatif | Réflexion des modèles gpt-oss : `low` (par défaut), `medium` ou `high`. Plus de réflexion consomme plus de tokens. |

### Un autre fournisseur

Créez `AI_API_KEY`, `AI_BASE_URL` et `AI_MODEL` :

| Fournisseur | `AI_BASE_URL` |
|---|---|
| xAI | `https://api.x.ai/v1` |
| Google Gemini | `https://generativelanguage.googleapis.com/v1beta/openai` |
| Mistral | `https://api.mistral.ai/v1` |
| OpenAI | `https://api.openai.com/v1` (ou seulement `OPENAI_API_KEY` et `AI_MODEL`) |

`AI_API_KEY` avec `AI_BASE_URL` passe avant `GROQ_API_KEY`, qui peut rester : la clé de Groq n'est jamais envoyée à un autre fournisseur (une `AI_BASE_URL` de xAI, Gemini, Mistral ou OpenAI sans `AI_API_KEY` est refusée). `AI_BASE_URL` seule, sans `AI_API_KEY`, change l'adresse de Groq (un proxy, par exemple).

## 2. Confidentialité

- Groq n'entraîne pas ses modèles sur les données reçues. Activez en plus **Zero Data Retention** dans les réglages de l'organisation de la console Groq : les requêtes ne sont alors pas conservées.
- Partent vers le fournisseur : la conversation et un contexte réduit de la pièce (mesures, features, analyse de fabrication et de fonderie). Le fichier 3D lui-même n'est jamais envoyé.
- Noms anonymisés : la case « Anonymiser les noms envoyés en ligne » (cochée par défaut) remplace, avant l'envoi et dans toutes les tâches, le nom du fichier, les noms des corps, la référence, la désignation, le client, le plan, les noms des noyaux et des composants du devis de l'onglet, et les noms des fichiers du chiffrage par « Pièce », « Corps 1 », « Client »… Dans la question et la conversation aussi, y compris un nom du devis changé depuis une question précédente. Sous la réponse, la page rappelle les vrais noms des étiquettes citées. Le modèle local (Ollama) reçoit toujours les vrais noms : rien ne quitte le site.
- Réponses du modèle local : ce qu'Ollama a répondu (choisi dans la page, ou en repli sur quota) ne part jamais en ligne avec la conversation, ni la question qui l'a précédé. Il a reçu les vrais noms et, pour le chiffrage, les montants internes : sa réponse peut les citer.
- Tâche « Chiffrage » : les valeurs tracées du devis partent aussi. Les montants internes (taux, coûts, prix, marges, pertes au feu, TRS) sont masqués, sauf si la case « Envoyer les montants internes du chiffrage à la passerelle » est cochée (pour l'onglet du navigateur seulement).
- Le contexte est transmis au modèle comme des **données**, entre délimiteurs. Les textes venant du fichier CAO ou du devis ne sont jamais suivis comme des instructions.
- L'IA explique, elle ne fixe aucune valeur : rien de ce qu'elle répond n'est appliqué au devis ni aux paramètres. Chaque nombre d'une réponse « Chiffrage » est comparé à la trace envoyée, sinon la réponse est marquée « non vérifiée ».
- Estimation du temps de cycle (bouton « Estimer le temps de cycle avec l'IA » de la page Chiffrage) : partent la géométrie de la pièce (poids, module, épaisseurs, encombrement, volume, surface, noyaux), sa coulée (îlot, pièces par cycle, mise au mille, série), le temps de la formule et ses termes, la tendance et, si la case « Envoyer les pièces similaires de l'historique à la passerelle » est cochée, les 5 pièces les plus semblables de l'historique avec leur temps de cycle, leur poids, leur module, leurs pièces par cycle, leur mise au mille et leur source. Ces temps sont des données confidentielles de l'entreprise : pour la passerelle, la case est décochée par défaut ; une fois cochée, le choix est gardé dans ce navigateur (pour Ollama, cochée par défaut : rien ne quitte le site). Les références de ces pièces sont remplacées par « Historique 1 »… avec les autres noms. L'estimation est une proposition : elle n'entre dans le devis que si l'on clique « Utiliser cette valeur ».
- « Banc d'essai IA » avec la passerelle : chaque pièce de l'historique part au fournisseur (sans son temps de cycle) et, avec la case cochée, ses pièces semblables avec leur temps : sur une série, presque tout l'historique. La page le dit et demande une confirmation avant chaque série.

## 3. Limites de l'offre gratuite de Groq

Par modèle et par organisation : 30 requêtes par minute, 1 000 par jour, 8 000 tokens par minute, 200 000 tokens par jour.

- Une question d'analyse consomme jusqu'à 4 000 à 5 000 tokens : les règles, le contexte (9 000 caractères au plus), la conversation récente et la réponse (1 200 tokens au plus). Comptez **une à deux questions d'analyse par minute**, davantage pour des questions générales (contexte résumé).
- Après chaque réponse, la page affiche le fournisseur, le modèle et, pour Groq, une estimation des questions restantes aujourd'hui : les tokens du jour (`tokens_limit_day`), moins ceux des requêtes déjà faites avec la clé depuis tous les PC (requêtes du jour × tokens moyens d'une requête), divisés par les tokens moyens d'une question (mesurés sur les dernières réponses de ce navigateur), sans dépasser les requêtes restantes. Sans `tokens_limit_day`, c'est le nombre de requêtes restantes. Les autres fournisseurs comptent leurs requêtes autrement, par minute pour OpenAI : rien n'est affiché.
- Quota atteint : la page affiche « Quota de Groq (offre gratuite) atteint. Réessayez dans … ». Une question trop longue pour une minute est refusée : commencez une nouvelle conversation ou choisissez une analyse plus ciblée.
- Repli automatique : avec la case « Repli automatique sur le modèle local » (cochée par défaut), une question refusée pour quota (HTTP 413 ou 429) est posée au modèle local Ollama, s'il répond, avec l'adresse et le modèle choisis pour lui. La réponse porte la mention « Quota en ligne atteint : réponse du modèle local (…) ».
- « Banc d'essai IA » (carte « Historique des temps de cycle » de la page Chiffrage) : une estimation du temps de cycle par pièce de l'historique, une demande à la fois. D'abord une toutes les 20 s, puis au rythme que permettent les tokens par minute renvoyés par la passerelle (environ une toutes les 30 à 40 s avec l'offre gratuite). Un refus pour quota arrête la série, sans repli sur le modèle local ; « Reprendre » la continue après le délai indiqué. Comptez de l'ordre de 4 000 tokens par pièce : un historique de 25 pièces prend environ un quart d'heure et la moitié des 200 000 tokens du jour.
- La passerelle limite aussi chaque adresse IP à 20 requêtes par minute. Ce compteur est tenu par chaque instance de la fonction, et Vercel peut en lancer plusieurs : c'est un frein, pas une limite exacte.
- Une requête fait au plus 200 Ko. Le fournisseur a 50 secondes pour répondre : la fonction est limitée à 60 secondes (`vercel.json`, offre Hobby).

## 4. Tester

1. Après le redéploiement, ouvrez `https://<projet>.vercel.app/api/ai` (l'adresse de **Settings → Domains**, ou celle d'un déploiement de test). Ouverte directement, elle répond « Code d'accès requis » : c'est normal (« Aucun code d'accès sur la passerelle » : créez `READER3D_ACCESS_CODE`). Testez avec curl :
   ```
   curl -s https://<projet>.vercel.app/api/ai -H "X-Reader3D-Code: <code>"
   curl -s https://<projet>.vercel.app/api/ai -H "Content-Type: application/json" -H "X-Reader3D-Code: <code>" \
     -d '{"task":"general","messages":[{"role":"user","content":"Bonjour"}]}'
   ```
   La première répond par la configuration : `{"provider":"Groq","model":"openai/gpt-oss-120b","models":[],"context_chars":9000,"access_code_required":true}`.
2. Dans 3D Reader, page **IA / analyse** : fournisseur « En ligne via la passerelle (Groq…) ». Sur Vercel, l'adresse est déjà remplie. Sur GitHub Pages, collez `https://<projet>.vercel.app/api/ai`.
3. Cliquez **Tester la connexion** : « Passerelle connectée : Groq · openai/gpt-oss-120b · … ». Si un code est demandé, le champ « Code d'accès » apparaît : saisissez-le, puis testez à nouveau.

## 5. Messages d'erreur

| Message | Que faire |
|---|---|
| Aucune clé d'API sur la passerelle | Créez `GROQ_API_KEY` pour l'environnement concerné (Production ou Preview), puis redéployez. |
| Aucun code d'accès sur la passerelle | Créez `READER3D_ACCESS_CODE` (un code long et aléatoire) pour Production et Preview, puis redéployez. |
| Clé d'API refusée par Groq | Clé erronée ou révoquée : recréez-la dans la console Groq, mettez à jour la variable, redéployez. |
| Clé d'API invalide (caractère non imprimable…) | La valeur collée contient un retour à la ligne ou un espace : recréez la variable avec la clé seule. |
| La clé de Groq n'est pas envoyée à … | `AI_BASE_URL` désigne un autre fournisseur : créez `AI_API_KEY` avec sa clé. |
| Origine non autorisée | Ajoutez l'adresse de la page à `READER3D_ALLOWED_ORIGINS`. Dans la page, cela s'affiche comme « La passerelle est injoignable ». |
| Code d'accès requis / incorrect | Saisissez le code de `READER3D_ACCESS_CODE` dans le champ « Code d'accès » de la page IA / analyse (la page Chiffrage n'en a pas : elle renvoie à ce champ). |
| Quota … atteint | Attendez le délai indiqué. |
| Modèle introuvable | Corrigez `AI_MODEL`. |
| … n'a pas répondu en 50 s | Réessayez, ou posez une question plus courte. |
| Réponse … coupée (limite de … tokens) | Question de la page IA : posez-la plus ciblée. Estimation du temps de cycle : augmentez `AI_MAX_TOKENS` (par exemple 2 000), puis redéployez ; le banc d'essai la compte comme « réponse inutilisable » et continue. |

Le détail technique de chaque refus du fournisseur est écrit dans les journaux de la fonction (Vercel → **Logs**) ; la page n'en reçoit jamais le texte.

## Pour les développeurs

- `GET /api/ai` : configuration publique `{provider, model, models, context_chars, access_code_required}`, jamais un secret.
- `POST /api/ai` : `{task, model, context, messages}`, avec l'en-tête `X-Reader3D-Code` si un code est défini. Réponse : `{output, provider, model, quota, usage}`, où `quota` reprend les en-têtes `x-ratelimit-*` du fournisseur : `requests_remaining_day`, `requests_limit_day` (Groq, qui compte les requêtes par jour ; ailleurs `requests_remaining`, `requests_limit`, sur la période du fournisseur), `tokens_remaining_minute`, `tokens_limit_minute`, `reset_requests`, `reset_tokens`, et `tokens_limit_day` quand il est connu (`AI_TOKENS_PER_DAY`, sinon l'offre gratuite de Groq) ; `usage` (quand le fournisseur le donne) : `prompt_tokens`, `completion_tokens`, `total_tokens`. Le banc d'essai de la page Chiffrage règle son rythme avec eux. En cas d'erreur : `{error}` en français, plus `retry_after` (secondes), `access_code_required` ou `truncated` (réponse JSON coupée à la limite de longueur) selon le cas.
- Appel au fournisseur : `POST {AI_BASE_URL}/chat/completions`. Les règles vont en message système. Le contexte suit dans un message à part, entre délimiteurs, puis viennent les 20 derniers messages de la conversation. Réponse en texte simple, sauf deux tâches en JSON (`response_format` `json_schema` strict, puis `json_object` avec le schéma dans les règles si le fournisseur le refuse) : `costing` (`analyse_chiffrage`) et `cycle_time` (estimation du temps de cycle de coulée : `estimation_s`, `fourchette_s`, `confiance`, `decomposition`, `comparaison`, `pieces_similaires_utilisees`, `hypotheses`, `a_verifier` ; schéma `CYCLE_SCHEMA`, le même que celui de `web/chiffrage/ai-cycle.js`). Un paramètre refusé (`reasoning_effort`, `temperature`, `max_completion_tokens`) est retiré ou remplacé, une fois : sur un HTTP 400, ou 422 (Mistral), l'erreur lue au format d'OpenAI, de Gemini (`[{error}]`) ou de Mistral (`{message: {detail}}`).
- Une estimation du temps de cycle tient dans la limite de réponse par défaut (1 200 tokens) : si elle était coupée (« Réponse de Groq coupée »), augmentez `AI_MAX_TOKENS` (par exemple 2 000), comme le dit le message.
- Journaux : le texte d'un refus du fournisseur (sans les valeurs refusées qu'une erreur de Mistral recopie), jamais celui d'une erreur levée avant l'envoi, qui peut citer les en-têtes et donc la clé.
- Tests : `tests/js/ai-gateway.test.mjs` (fonction seule, fournisseur simulé), `tests/js/ai-cycle.test.mjs` (estimation du temps de cycle), `tests/e2e/features.test.mjs` (la page avec la passerelle et un Groq simulé) et `tests/e2e/costing.test.mjs` (la page Chiffrage avec une passerelle simulée qui répond à `cycle_time`, estimation et banc d'essai), `tests/js/backtest.test.mjs` (rythme, arrêt sur quota et reprise du banc d'essai).
