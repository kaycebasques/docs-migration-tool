const readline = require('readline');
const puppeteer = require('puppeteer');
const fs = require('fs');
const TurndownService = require('turndown');
const axios = require('axios');
const outputDirectory = 'output';
const events = require('events');
const prettier = require('prettier');
let config;

function init() {
  let targets = [];
  let done = [];
  let sentinels = {
    targets: false,
    done: false
  };
  if (fs.existsSync('./config.json')) {
    config = require('./config.json');
  }
  if (config.history && !fs.existsSync('./done.txt')) {
    fs.writeFileSync('./done.txt', '');
  }
  const eventsEmitter = new events.EventEmitter();
  eventsEmitter.addListener('ready', () => {
    // User has indicated that they want to record progress but we're not yet done
    // reading the done.txt file, so there's no work to do yet.
    if (config.history && !sentinels.done) return;
    if (!sentinels.targets) return;
    // Remove the pages that we've already crawled from the list of targets.
    const targetsSet = new Set(targets);
    const doneSet = new Set(done);
    for (let element of doneSet) {
      targetsSet.delete(element);
    }
    targets = Array.from(targetsSet);
    migrate(targets, done);
  });
  // TODO(kaycebasques): How do we handle this when the user has indicated that
  // they want to save progress? Should we not delete the output directory?
  fs.rmdirSync(outputDirectory, {recursive: true});
  const targetsFile = readline.createInterface({
    input: fs.createReadStream('targets.txt')
  });
  targetsFile.on('line', line => {
    targets.push(line);
  });
  targetsFile.on('close', () => {
    sentinels.targets = true;
    eventsEmitter.emit('ready');
  });
  let doneFile;
  if (config.history) {
    donefile = readline.createInterface({
      input: fs.createReadStream('done.txt')
    });
    doneFile.on('line', line => {
      done.push(line);
    });
    doneFile.on('close', () => {
      sentinels.done = true;
      eventsEmitter.emit('ready');
    });
  }
}

async function download(image, destinationDirectory) {
  const pathname = new URL(image).pathname;
  const filename = pathname.substring(pathname.lastIndexOf('/') + 1);
  const destination = `${destinationDirectory}/${filename}`;
  const writer = fs.createWriteStream(destination);
  const response = await axios({
    url: image,
    method: 'GET',
    responseType: 'stream'
  });
  response.data.pipe(writer);
}

async function modify(page) {
  if (!config || !config.modifications || !fs.existsSync(config.modifications)) return;
  await page.addScriptTag({
    path: config.modifications
  });
}

async function cleanup(page) {
  if (!config || !config.deletions) return;
  const selectors = config.deletions;
  for (let i = 0; i < selectors.length; i++) {
    const selector = selectors[i];
    await page.$$eval(selector, nodes => nodes.forEach(node => node.remove()));
  }
}

async function migrate(targets, done) {
  // TODO get the config if it exists and use its deletion/modification directions
  //const config = require('./config.json');
  const browser = await puppeteer.launch({
    headless: false,
    devtools: true
  });
  const page = await browser.newPage();
  // TODO move to init? And expose page as a global?
  done = done.length > 0 ? `${done.join('\n')}` : '';
  for (let i = 0; i < targets.length; i++) {
    let frontmatter = '---\n';
    const target = targets[i];
    const pathname = new URL(target).pathname;
    const destination = `${outputDirectory}${pathname}`;
    fs.mkdirSync(destination, {recursive: true});
    await page.goto(target, {
      waitUntil: 'networkidle0'
    });
    await cleanup(page);
    await modify(page);
    // TODO move to config.json
    const contentSelector = config.selectors.main;
    const html = await page.$eval(contentSelector, element => element.innerHTML);
    if (config.selectors.title) {
      const title = await page.$eval(config.selectors.title, element => element.textContent);
      frontmatter += `title: ${title}\n`;
    }
    if (config.selectors.date) {
      // Added this because in the case of developers.google.com/web, we do a network request
      // to fetch the creation date and insert that information into the page.
      // TODO(kaycebasques): Just loop through all user-provided selectors and wait for them all?
      await page.waitForSelector(config.selectors.date);
      const date = await page.$eval(config.selectors.date, element => element.textContent);
      frontmatter += `date: ${date}\n`;
    }
    if (config.selectors.update) {
      await page.waitForSelector(config.selectors.update);
      const update = await page.$eval(config.selectors.update, element => element.textContent);
      frontmatter += `updated: ${update}\n`;
    }
    const description = await page.$eval('meta[name="description"]', element => element.content);
    frontmatter += `description: ${description}\n`;
    const images = await page.$$eval(`${contentSelector} img`, images => images.map(image => image.src));
    for (let i = 0; i < images.length; i++) {
      await download(images[i], destination);
    }
    const turndownService = TurndownService({
      headingStyle: 'atx',
      codeBlockStyle: 'fenced',
      linkStyle: 'referenced'
    });
    const markdown = turndownService.turndown(html);
    frontmatter += 
        'authors: TODO\n' +
        'date: TODO\n' +
        'tags:\n  - TODO\n' +
        '---\n\n';
    const output = `${frontmatter}${markdown}`;
    const formattedOutput = prettier.format(output, { 
      parser: 'markdown', 
      proseWrap: 'always',
      printWidth: 100
    });
    fs.writeFileSync(`${destination}/index.md`, formattedOutput);
    done += `${target}\n`;
    if (config.history) fs.writeFileSync('done.txt', done);
  }
  await browser.close();
}

try {
  init();
} catch (error) {
  console.error({error});
}