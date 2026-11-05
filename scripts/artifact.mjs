// Transforme la sortie « fichier unique » (dist-single/index.html) en page d'artefact
// claude.ai : le squelette <html>/<head>/<body> est fourni par la plateforme.
import { readFileSync, writeFileSync } from 'node:fs';

const src = readFileSync(new URL('../dist-single/index.html', import.meta.url), 'utf8');
const head = /<head>([\s\S]*?)<\/head>/.exec(src)[1];
const body = /<body>([\s\S]*?)<\/body>/.exec(src)[1];
const title = /<title>[\s\S]*?<\/title>/.exec(head)[0];
const metas = (head.match(/<meta name="(description|theme-color|color-scheme)"[^>]*>/g) ?? []).join('\n');
const styles = (head.match(/<style[\s\S]*?<\/style>/g) ?? []).join('\n');
const scripts = (head.match(/<script[\s\S]*?<\/script>/g) ?? []).join('\n');
const out = `${title}\n${metas}\n${styles}\n${body.trim()}\n${scripts}\n`;
writeFileSync(new URL('../dist-single/souvenirs-studio.html', import.meta.url), out);
console.log('artefact :', (out.length / 1024).toFixed(0), 'Ko');
