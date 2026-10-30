'use strict';
// Jev image assist: images sent in a chat are not shown to the model. It asks Jev yes/no questions about them, and reads
// one itself (image_read) only when that cannot settle what it needs, which saves the image tokens.
const { randomUUID } = require('node:crypto');
const { jevImage, imageData } = require('../image-input.cjs');

const IMAGE = { type: 'integer', minimum: 1, description: 'Image number (image_list). Omit for the latest image.' };
const TOOLS = [
  { name: 'image_list', description: 'List the images sent in this chat, now or earlier: each image number, when it was sent and the start of its message.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'image_ask', description: 'Ask Jev, a fast and very cheap image classifier, yes/no questions about an image sent in this chat. Ask Jev first: each answer is yes, no or unsure, and you accept yes and no. Only when Jev is unsure, or your question has no yes/no answer, read the image with image_read.',
    inputSchema: { type: 'object', properties: {
      image: IMAGE,
      // No minItems/maxItems: the Hub's structured replies accept only structured.cjs's schema words; imageTool checks 1-8.
      questions: { type: 'array', items: { type: 'string', minLength: 1, maxLength: 400 }, description: '1 to 8 yes/no questions about what the image shows, e.g. "Is an error dialog open?"' },
    }, required: ['questions'], additionalProperties: false } },
  { name: 'image_read', description: 'Show you an image sent in this chat. It costs the image tokens image_ask saves, so use it only when Jev is unsure or what you need is not a yes/no answer (reading text, describing a layout, judging art).',
    inputSchema: { type: 'object', properties: { image: IMAGE }, additionalProperties: false } },
];
const NAMES = new Set(TOOLS.map(tool => tool.name));
// Jev's probability that the answer is yes; between the two bounds the answer is unsure.
const CERTAIN = 0.9;

// Every image sent in this chat, oldest first: image N is the Nth, available or not.
function chatImages(session) {
  return [...(session.items || []), session.pendingMessage].filter(item => item?.type === 'userMessage')
    .flatMap(item => (item.content || []).filter(part => part.type === 'image').map((part, index) => ({ url: part.url, key: `${item.id}/${index}`, item })));
}

// Each user message's image numbers, so history a model reads names them ("[Image 3 attached]").
function imageNumbers(session) {
  const numbers = new Map();
  chatImages(session).forEach(({ item }, index) => numbers.set(item.id, [...(numbers.get(item.id) || []), index + 1]));
  return numbers;
}
const imageLabel = numbers => numbers.length === 1 ? `Image ${numbers[0]}` : `Images ${numbers[0]} to ${numbers.at(-1)}`;

// What the model gets instead of the images: their numbers, and how to learn what they show.
function imageNotes(first, count, canSee) {
  const last = first + count - 1;
  const which = count === 1 ? `Image ${first} is` : `Images ${first} to ${last} are`, them = count === 1 ? 'it' : 'them';
  const numbers = count === 1 ? `image: ${first}` : `image: ${first} to ${last}`;
  return canSee ? `\n\n[${which} attached but not shown, to save tokens. Ask Jev yes/no questions about ${them} with image_ask (${numbers}); read one with image_read only when Jev is unsure or you need more than a yes/no answer.]`
    : `\n\n[${which} attached, but you cannot see images. Ask Jev yes/no questions about ${them} with the image_ask tool (${numbers}).]`;
}

// Each image is fitted to Jev's size limits once; a chat asks about the same few images.
const fitted = new Map();
function fit(key, url) {
  if (!fitted.has(key)) {
    fitted.set(key, jevImage(url).catch(() => null));
    if (fitted.size > 16) fitted.delete(fitted.keys().next().value);
  }
  return fitted.get(key);
}

async function imageTool(jev, session, name, args) {
  const images = chatImages(session);
  if (name === 'image_list') {
    if (Object.keys(args).length) throw new Error('image_list takes no arguments.');
    return images.map(({ item }, index) => ({ image: index + 1, sentAt: new Date(item.createdAt || 0).toISOString(),
      message: (item.content || []).filter(part => part.type === 'text').map(part => part.text).join(' ').slice(0, 120) }));
  }
  // Strict tool schemas send an omitted optional argument as null.
  const image = args.image ?? images.length, { questions } = args;
  if (name === 'image_read' ? Object.keys(args).some(key => key !== 'image')
    : Object.keys(args).some(key => !['image', 'questions'].includes(key)) || !Array.isArray(questions) || !questions.length || questions.length > 8 ||
      questions.some(question => typeof question !== 'string' || !question.trim() || question.length > 400))
    throw new Error(name === 'image_read' ? 'image_read takes only an image number.' : 'Ask 1 to 8 yes/no questions of up to 400 characters each.');
  if (!images.length) throw new Error('No image has been sent in this chat.');
  if (!Number.isInteger(image) || image < 1 || image > images.length) throw new Error(`Choose an image from 1 to ${images.length} (image_list).`);
  const { url, key } = images[image - 1];
  if (typeof url !== 'string' || !url.startsWith('data:image/')) throw new Error(`Image ${image} is no longer available.`);
  if (name === 'image_read') {
    // The model this turn runs on (its route); the Hub's route is its own model.
    if (session.routes?.at(-1)?.images === false) throw new Error('This model cannot see images. Use image_ask, or say you could not check the image.');
    const { mime, data } = imageData(url);
    // The image first: Codex's code mode forwards an MCP image as image(result.content[0]).
    return { content: [{ type: 'image', data, mimeType: mime }, { type: 'text', text: `Image ${image}` }] };
  }
  if (!jev?.configured) throw new Error('Jev is not set up, so it cannot answer image questions.');
  const asset = await fit(key, url);
  if (!asset) throw new Error(`Image ${image} cannot be sent to Jev.`);
  // A random reference: Jev replaces it anywhere in the request, even inside a question.
  const ref = randomUUID();
  const result = await jev.evaluate({ image: ref }, Object.fromEntries(questions.map((question, index) =>
    [`q${index + 1}`, { type: 'noul', instructions: `Answer this yes/no question about the image: ${question}` }])), undefined, 15000, { [ref]: asset });
  const answers = questions.map((question, index) => {
    const yes = result.answers[`q${index + 1}`].noul;
    return { question, answer: yes >= CERTAIN ? 'yes' : yes <= 1 - CERTAIN ? 'no' : 'unsure', probability: Math.round(yes * 100) / 100 };
  });
  return { image, answers, ...(answers.some(entry => entry.answer === 'unsure') ? { note: 'Jev is unsure: read the image with image_read, or say you could not check it if you cannot see images.' } : {}) };
}

// The chat's activity row for an image step (Controller.recordStep): its title, and the lines it opens to.
function imageStep(by, name, result, ms) {
  if (name === 'image_list') return { title: `${by} lists the chat's images`,
    lines: result.map(entry => `Image ${entry.image} · ${entry.message}`) };
  if (name === 'image_read') return { title: `${by} reads ${result.content.find(part => part.type === 'text').text.replace('Image', 'image')}`,
    lines: [`The original image, shown to the model · ${ms} ms`] };
  return { title: `Jev reads image ${result.image}`,
    lines: [...result.answers.map(entry => `${entry.question} → Jev: ${entry.answer} (${entry.probability})`), `Asked by ${by} · ${ms} ms`] };
}

module.exports = { TOOLS, NAMES, CERTAIN, chatImages, imageNumbers, imageLabel, imageNotes, imageTool, imageStep };
