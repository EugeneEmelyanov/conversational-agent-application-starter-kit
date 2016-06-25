/**
 * Copyright 2015 IBM Corp. All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

'use strict';

var express  = require('express'),
  app        = express(),
  extend     = require('util')._extend,
  pkg        = require('./package.json'),
  training   = require('./training/setup'),
  Q          = require('q'),
  client    = require('twilio')("ACf3e2b2ebd4b49c1968ac2efa0c9858c0", "9fec0a2842e3fa7002a13af636612c15");


// Bootstrap application settings
require('./config/express')(app);

var PROMPT_MOVIE_SELECTED = 'USER CLICKS BOX';
var PROMPT_MOVIES_RETURNED = 'UPDATE NUM_MOVIES';
var PROMPT_CURRENT_INDEX = 'UPDATE CURRENT_INDEX';
var log = console.log.bind(null, '  ');
var SESSIONS = {};

var apis = null;

// promises
var converse, updateProfile, getIntent, searchMovies, getMovieInformation = null;

// train the service and create the promises with the result
training.train(function(err) {
	if (err){
    log('ERROR:', err.error);
  }

  apis = require('./api/services');

  converse = Q.nfbind(apis.dialog.conversation.bind(apis.dialog));
  updateProfile = Q.nfbind(apis.dialog.updateProfile.bind(apis.dialog));
  getIntent = Q.nfbind(apis.classifier.classify.bind(apis.classifier));
  searchMovies = Q.nfbind(apis.movieDB.searchMovies.bind(apis.movieDB));
  getMovieInformation = Q.nfbind(apis.movieDB.getMovieInformation.bind(apis.movieDB));
});

// create the conversation
app.post('/api/create_conversation', function(req, res, next) {
  converse(req.body)
  .then(function(result){
    res.json(result[0]);
  })
  .catch(next);
});

function createConversation(cb) {
    converse({}).then(function(result){
        cb(result[0], true);
    })
}
app.get('/api/twillio', function(req, res, next) {
    log('--------------------------');
    log('1. classifying user intent. SMS: ' + req.query.Body);
    var input = req.query.Body,
        inboundNumber = req.query.From,
        outboundNumber = req.query.To;

    if (SESSIONS[inboundNumber]) {
        proceed(SESSIONS[inboundNumber], false);
    } else {
        createConversation(proceed);
    }
    function proceed(session, first_time) {
        SESSIONS[inboundNumber] = session;
        if (first_time) {
            sendMessage(session.response[0]);
            return;
        }
        session.input = input;
        getIntent({ text: input })
            .then(function(result) {
                log('2. updating the dialog profile with the user intent');
                var classes = result[0].classes;
                var profile = {
                    client_id: session.client_id,
                    name_values: [
                        { name:'Class1', value: classes[0].class_name },
                        { name:'Class1_Confidence', value: classes[0].confidence },
                        { name:'Class2', value: classes[1].class_name },
                        { name:'Class2_Confidence', value: classes[1].confidence }
                    ]
                };
                return updateProfile(profile);
            })
            .catch(function(error ){
                log('2.', error.description || error);
            })
            .then(function() {
                log('3. calling dialog.conversation()');
                return converse(session)
                    .then(function(result) {
                        var conversation = result[0];
                        if (searchNow(conversation.response.join(' '))) {
                            log('4. dialog thinks we have information enough to search for movies');
                            var searchParameters = parseSearchParameters(conversation);
                            conversation.response = conversation.response.slice(0, 1);
                            log('5. searching for movies in themoviedb.com');
                            return searchMovies(searchParameters)
                                .then(function(searchResult) {
                                    log('6. updating the dialog profile with the result from themoviedb.com');
                                    var profile = {
                                        client_id: session.client_id,
                                        name_values: [
                                            { name:'Current_Index', value: searchResult.curent_index },
                                            { name:'Total_Pages', value: searchResult.total_pages },
                                            { name:'Num_Movies', value: searchResult.total_movies }
                                        ]
                                    };
                                    return updateProfile(profile)
                                        .then(function() {
                                            log('7. calling dialog.conversation()');
                                            var params = extend({}, session);
                                            if (['new','repeat'].indexOf(searchParameters.page) !== -1)
                                                params.input = PROMPT_MOVIES_RETURNED;
                                            else
                                                params.input = PROMPT_CURRENT_INDEX;

                                            return converse(params)
                                                .then(function(result) {
                                                    for(var k in searchResult)
                                                        result[0][k]=searchResult[k];
                                                    sendMessage(result[0]);
                                                });
                                        });
                                });
                        } else {
                            log('4. not enough information to search for movies, continue the conversation');
                            var respond = '';
                            for(var i=0;i < conversation.response.length; i ++) {
                                if ("" != conversation.response[i]) {
                                    respond = conversation.response[i];
                                    break;
                                }
                            }
                            sendMessage(respond);
                            res.json(conversation);
                        }
                    });
            })
            .catch(next);
    }

});

function sendMessage(respond, cb) {

    client.sendMessage({

        to:'+14159261929', // Any number Twilio can deliver to
        from: '+12018857770', // A number you bought from Twilio and can use for outbound communication
        body: respond // body of the SMS message

    }, function(err, responseData) { //this function is executed when a response is received from Twilio

        if (!err) { // "err" is an error received during the request, if any

            // "responseData" is a JavaScript object containing data received from Twilio.
            // A sample response from sending an SMS message is here (click "JSON" to see how the data appears in JavaScript):
            // http://www.twilio.com/docs/api/rest/sending-sms#example-1

            console.log(responseData.from); // outputs "+14506667788"
            console.log(responseData.body); // outputs "word to your mother."

        }
        if (cb) {
            cb(responseData);
        }
    });
}

// converse
app.post('/api/conversation', function(req, res, next) {
    nextConversationStep(req, res, next);
});

function searchNow(message) {
  return message.toLowerCase().indexOf('search_now') !== -1;
}

function parseSearchParameters(conversation) {
  var params = conversation.response[1].toLowerCase().slice(1, -1);
  params = params.replace(/(['"])?([a-zA-Z0-9_]+)(['"])?:/g, '"$2": ');
  return JSON.parse(params);
}

function nextConversationStep(req, res, next) {
    log('--------------------------');
    log('1. classifying user intent');
    getIntent({ text: req.body.input })
        .then(function(result) {
            log('2. updating the dialog profile with the user intent');
            var classes = result[0].classes;
            var profile = {
                client_id: req.body.client_id,
                name_values: [
                    { name:'Class1', value: classes[0].class_name },
                    { name:'Class1_Confidence', value: classes[0].confidence },
                    { name:'Class2', value: classes[1].class_name },
                    { name:'Class2_Confidence', value: classes[1].confidence }
                ]
            };
            return updateProfile(profile);
        })
        .catch(function(error ){
            log('2.', error.description || error);
        })
        .then(function() {
            log('3. calling dialog.conversation()');
            return converse(req.body)
                .then(function(result) {
                    var conversation = result[0];
                    if (searchNow(conversation.response.join(' '))) {
                        log('4. dialog thinks we have information enough to search for movies');
                        var searchParameters = parseSearchParameters(conversation);
                        conversation.response = conversation.response.slice(0, 1);
                        log('5. searching for movies in themoviedb.com');
                        return searchMovies(searchParameters)
                            .then(function(searchResult) {
                                log('6. updating the dialog profile with the result from themoviedb.com');
                                var profile = {
                                    client_id: req.body.client_id,
                                    name_values: [
                                        { name:'Current_Index', value: searchResult.curent_index },
                                        { name:'Total_Pages', value: searchResult.total_pages },
                                        { name:'Num_Movies', value: searchResult.total_movies }
                                    ]
                                };
                                return updateProfile(profile)
                                    .then(function() {
                                        log('7. calling dialog.conversation()');
                                        var params = extend({}, req.body);
                                        if (['new','repeat'].indexOf(searchParameters.page) !== -1)
                                            params.input = PROMPT_MOVIES_RETURNED;
                                        else
                                            params.input = PROMPT_CURRENT_INDEX;

                                        return converse(params)
                                            .then(function(result) {
                                                for(var k in searchResult)
                                                    result[0][k]=searchResult[k];
                                                res.json(result[0]);
                                            });
                                    });
                            });
                    } else {
                        log('4. not enough information to search for movies, continue the conversation');
                        res.json(conversation);
                        var respond = '';
                        for(var i=0;i < conversation.response.length; i ++) {
                            if ("" != conversation.response[i]) {
                                respond = conversation.response[i];
                                break;
                            }
                        }
                        //client.sendMessage({
                        //
                        //    to:'+14159261929', // Any number Twilio can deliver to
                        //    from: '+12018857770', // A number you bought from Twilio and can use for outbound communication
                        //    body: respond // body of the SMS message
                        //
                        //}, function(err, responseData) { //this function is executed when a response is received from Twilio
                        //
                        //    if (!err) { // "err" is an error received during the request, if any
                        //
                        //        // "responseData" is a JavaScript object containing data received from Twilio.
                        //        // A sample response from sending an SMS message is here (click "JSON" to see how the data appears in JavaScript):
                        //        // http://www.twilio.com/docs/api/rest/sending-sms#example-1
                        //
                        //        console.log(responseData.from); // outputs "+14506667788"
                        //        console.log(responseData.body); // outputs "word to your mother."
                        //
                        //    }
                        //});

                    }
                });
        })
        .catch(next);
}

app.get('/api/movies', function(req, res, next) {
  getMovieInformation(req.query)
  .then(function(movie){
    var profile = {
      client_id: req.body.client_id,
      name_values: [
        { name:'Selected_Movie', value: movie.movie_name },
        { name:'Popularity_Score', value: movie.popularity * 10 }
      ]
    };
    return updateProfile(profile)
    .then(function() {
      var params = {
        client_id: req.query.client_id,
        conversation_id: req.query.conversation_id,
        input: PROMPT_MOVIE_SELECTED
      };
      return converse(params)
      .then(function(result) {
        res.json(extend(result[0], { movies: [movie]}));
      });
    });
  })
  .catch(next);
});


/**
 * Returns the classifier_id and dialog_id to the user.
 */
app.get('/api/services', function(req, res) {
  res.json({
    dialog_id: apis ? apis.dialog_id : 'Unknown',
    classifier_id: apis ? apis.classifier_id : 'Unknown'
  });
});

// error-handler application settings
require('./config/error-handler')(app);
module.exports = app;