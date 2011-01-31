
bookmarks.getSearchURL = function(text, useDefsearch) {
  let url = null;
  let postData = {};
  let searchString =
      (useDefsearch ? options["defsearch"] + " " : "")
      + text;

  url = window.getShortcutOrURI(searchString, postData);

  if (url == searchString)
    return null;

  if (postData && postData.value)
    return [url, postData.value];

  return [url, null]; // can be null
}

