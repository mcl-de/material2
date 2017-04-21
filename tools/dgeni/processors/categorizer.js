/**
 * We want to avoid emitting selectors that are deprecated but don't have a way to mark
 * them as such in the source code. Thus, we maintain a separate blacklist of selectors
 * that should not be emitted in the documentation.
 */
const SELECTOR_BLACKLIST  = new Set([
  '[portal]',
  '[portalHost]',
  'textarea[md-autosize]',
  '[overlay-origin]',
  '[connected-overlay]',
]);

/**
 * Processor to add properties to docs objects.
 *
 * isMethod     | Whether the doc is for a method on a class.
 * isDirective  | Whether the doc is for a @Component or a @Directive
 * isService    | Whether the doc is for an @Injectable
 * isNgModule   | Whether the doc is for an NgModule
 */
module.exports = function categorizer() {
  return {
    $runBefore: ['docs-processed'],
    $process: function (docs) {
      docs.filter(doc => doc.docType === 'class').forEach(doc => decorateClassDoc(doc));
    }
  };

  /**
   * Decorates all class docs inside of the dgeni pipeline.
   * - Methods and properties of a class-doc will be extracted into separate variables.
   * - Identifies directives, services or NgModules and marks them them in class-doc.
   */
  function decorateClassDoc(classDoc) {
    // Resolve all methods and properties from the classDoc. Includes inherited docs.
    classDoc.methods = resolveMethods(classDoc);
    classDoc.properties = resolveProperties(classDoc);

    // Call decorate hooks that can modify the method and property docs.
    classDoc.methods.forEach(doc => decorateMethodDoc(doc));
    classDoc.properties.forEach(doc => decoratePropertyDoc(doc));

    decoratePublicDoc(classDoc);

    // Categorize the current visited classDoc into its Angular type.
    if (isDirective(classDoc)) {
      classDoc.isDirective = true;
      classDoc.directiveExportAs = getDirectiveExportAs(classDoc);
      classDoc.directiveSelectors =  getDirectiveSelectors(classDoc);
    } else if (isService(classDoc)) {
      classDoc.isService = true;
    } else if (isNgModule(classDoc)) {
      classDoc.isNgModule = true;
    }
  }

  /**
   * Method that will be called for each method doc. The parameters for the method-docs
   * will be normalized, so that they can be easily used inside of dgeni templates.
   */
  function decorateMethodDoc(methodDoc) {
    normalizeMethodParameters(methodDoc);
    decoratePublicDoc(methodDoc);

    // Mark methods with a `void` return type so we can omit show the return type in the docs.
    methodDoc.showReturns = methodDoc.returnType && methodDoc.returnType != 'void';
  }

  /**
   * Method that will be called for each property doc. Properties that are Angular inputs or
   * outputs will be marked. Aliases for the inputs or outputs will be stored as well.
   */
  function decoratePropertyDoc(propertyDoc) {
    decoratePublicDoc(propertyDoc);

    propertyDoc.isDirectiveInput = isDirectiveInput(propertyDoc);
    propertyDoc.directiveInputAlias = getDirectiveInputAlias(propertyDoc);

    propertyDoc.isDirectiveOutput = isDirectiveOutput(propertyDoc);
    propertyDoc.directiveOutputAlias = getDirectiveOutputAlias(propertyDoc);
  }

  /**
   * Decorates public exposed docs. Creates a property on the doc that indicates whether
   * the item is deprecated or not.
   **/
  function decoratePublicDoc(doc) {
    doc.isDeprecated = isDeprecatedDoc(doc);
  }
};

/** Function that walks through all inherited docs and collects public methods. */
function resolveMethods(classDoc) {
  let methods = classDoc.members.filter(member => member.hasOwnProperty('parameters'));

  if (classDoc.inheritedDoc) {
    methods = methods.concat(resolveMethods(classDoc.inheritedDoc));
  }

  return methods;
}

/** Function that walks through all inherited docs and collects public properties. */
function resolveProperties(classDoc) {
  let properties = classDoc.members.filter(member => !member.hasOwnProperty('parameters'));

  if (classDoc.inheritedDoc) {
    properties = properties.concat(resolveProperties(classDoc.inheritedDoc));
  }

  return properties;
}


/**
 * The `parameters` property are the parameters extracted from TypeScript and are strings
 * of the form "propertyName: propertyType" (literally what's written in the source).
 *
 * The `params` property is pulled from the `@param` JsDoc tag. We need to merge
 * the information of these to get name + type + description.
 *
 * We will use the `params` property to store the final normalized form since it is already
 * an object.
 */
function normalizeMethodParameters(method) {
  if (method.parameters) {
    method.parameters.forEach(parameter => {
      let [parameterName, parameterType] = parameter.split(':');

      // If the parameter is optional, the name here will contain a '?'. We store whether the
      // parameter is optional and remove the '?' for comparison.
      let isOptional = false;
      if (parameterName.includes('?')) {
        isOptional = true;
        parameterName = parameterName.replace('?', '');
      }

      if (!method.params) {
        method.params = [];
      }

      let jsDocParam = method.params.find(p => p.name == parameterName);

      if (!jsDocParam) {
        jsDocParam = {name: parameterName};
        method.params.push(jsDocParam);
      }

      jsDocParam.type = parameterType.trim();
      jsDocParam.isOptional = isOptional;
    });
  }
}

function isDirective(doc) {
  return hasClassDecorator(doc, 'Component') || hasClassDecorator(doc, 'Directive');
}

function isService(doc) {
  return hasClassDecorator(doc, 'Injectable')
}

function isNgModule(doc) {
  return hasClassDecorator(doc, 'NgModule');
}

function isDirectiveOutput(doc) {
  return hasMemberDecorator(doc, 'Output');
}

function isDirectiveInput(doc) {
  return hasMemberDecorator(doc, 'Input');
}

function isDeprecatedDoc(doc) {
  return (doc.tags && doc.tags.tags || []).some(tag => tag.tagName === 'deprecated');
}

function getDirectiveInputAlias(doc) {
  return isDirectiveInput(doc) ? doc.decorators.find(d => d.name == 'Input').arguments[0] : '';
}

function getDirectiveOutputAlias(doc) {
  return isDirectiveOutput(doc) ? doc.decorators.find(d => d.name == 'Output').arguments[0] : '';
}

function getDirectiveSelectors(classDoc) {
  let metadata = classDoc.decorators
    .find(d => d.name === 'Component' || d.name === 'Directive').arguments[0];

  let selectorMatches = /selector\s*:\s*(?:"|')([^']*?)(?:"|')/g.exec(metadata);
  selectorMatches = selectorMatches && selectorMatches[1];

  return selectorMatches ? selectorMatches.split(/\s*,\s*/)
    .filter(s => s !== '' && !s.includes('mat') && !SELECTOR_BLACKLIST.has(s))
    : selectorMatches;
}

function getDirectiveExportAs(doc) {
  let metadata = doc.decorators
      .find(d => d.name === 'Component' || d.name === 'Directive').arguments[0];

  // Use a Regex to determine the exportAs metadata because we can't parse the JSON due to
  // environment variables inside of the JSON.
  let exportMatches = /exportAs\s*:\s*(?:"|')(\w+)(?:"|')/g.exec(metadata);

  return exportMatches && exportMatches[1];
}

function hasMemberDecorator(doc, decoratorName) {
  return doc.docType == 'member' && hasDecorator(doc, decoratorName);
}

function hasClassDecorator(doc, decoratorName) {
  return doc.docType == 'class' && hasDecorator(doc, decoratorName);
}

function hasDecorator(doc, decoratorName) {
  return doc.decorators &&
      doc.decorators.length &&
      doc.decorators.some(d => d.name == decoratorName);
}
