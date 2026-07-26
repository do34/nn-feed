#/bin/bash

git pull

node index.js

git add rss/inn.xml rss/newsItems.json

if git diff --staged --quiet; then
echo "No changes to commit"
exit 0
fi

git commit -m "Update RSS feed"
git pull --rebase origin main
git push
