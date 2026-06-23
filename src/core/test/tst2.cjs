const { extractGeneric } = require('../models/basic_models/generic');

let ext = extractGeneric;
ext("https://tioanime.com/ver/ichijouma-mankitsugurashi-11").then(videos => {
  console.log("videos", videos);
}).catch(err => {
  console.error("Error:", err);
});